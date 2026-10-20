import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  query,
  type EffortLevel,
  type ModelInfo,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'

import { config } from './config.js'
import type { Project } from './projects.js'
import { convert, type RenderedMessage } from './transcript.js'

/** One question from the AskUserQuestion tool, flattened for the phone. */
export interface PhoneQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description: string }[]
}

/** What came back from the phone for one question. */
export interface PhoneAnswer {
  question: string
  selected: string[]
}

/** Events pushed to attached phones. */
export type OutEvent =
  | { t: 'session'; sessionId: string }
  | { t: 'busy'; busy: boolean }
  | { t: 'partial'; text: string }
  | { t: 'thinking' }
  | { t: 'message'; message: RenderedMessage }
  | {
      t: 'permission'
      id: string
      name: string
      summary: string
      input: string
      /** The CLI's own prompt sentence, e.g. "Claude wants to read foo.txt". */
      title?: string
      /** Why this needed a human — in auto mode, usually the classifier's reason. */
      reason?: string
    }
  | { t: 'question'; id: string; questions: PhoneQuestion[] }
  | { t: 'permission_resolved'; id: string; decision: Verdict }
  | { t: 'background'; tasks: BackgroundTask[] }
  | { t: 'result'; isError: boolean; costUsd: number | null; durationMs: number | null; text: string | null }
  | { t: 'error'; message: string }
  | { t: 'notice'; message: string }
  // Live session metadata, so the phone can show what it is actually talking to.
  | { t: 'init'; model: string; permissionMode: string; version: string; toolCount: number }
  | { t: 'progress'; tool: string; seconds: number }
  | { t: 'mode'; mode: PermissionMode }
  | { t: 'commands'; commands: SlashCommand[] }
  | { t: 'models'; models: ModelInfo[]; current: string | null }
  /** The effort the session will send on its next request, when known. */
  | { t: 'effort'; current: EffortLevel | null }
  /** Answer to "open the effort picker": what the current model offers. */
  | { t: 'effortInfo'; current: EffortLevel | null; levels: EffortLevel[]; model: string | null }

/**
 * How a request card ended. `expired` and `cancelled` are not the user's
 * decision and must not be shown as "Denied".
 */
export type Verdict = 'allow' | 'deny' | 'expired' | 'cancelled'

export interface BackgroundTask {
  id: string
  type: string
  description: string
}

export type Sink = (event: OutEvent) => void

export const PERMISSION_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
]

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as string[]).includes(value)
}

export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as string[]).includes(value)
}

/**
 * `getSettings()` is the SDK's wrapper for the CLI's `get_settings` control
 * request, whose `applied.effort` is the level the next request will really
 * use — after per-model settings, env overrides, org caps and model-support
 * downgrades. It ships in the SDK but not in its public typings, so it is
 * reached through this narrow shape and treated as optional: without it the
 * chip simply shows the last level picked here. (The init message documents
 * an `effort` field too, but the subprocess transport does not send it.)
 */
type WithSettings = { getSettings?: () => Promise<{ applied?: { effort?: unknown } }> }

/**
 * The mode the CLI will start in when no `--permission-mode` is passed.
 *
 * Only used to label the mode chip before the first turn — the CLI is not told
 * this; it resolves the same settings itself, and its init message then
 * reports the real mode (which also covers auto mode being unavailable and
 * falling back). Later sources override earlier ones, managed policy last.
 */
export function configuredDefaultMode(projectPath: string): PermissionMode {
  const files = [
    path.join(config.claudeHome, 'settings.json'),
    path.join(projectPath, '.claude', 'settings.json'),
    path.join(projectPath, '.claude', 'settings.local.json'),
    '/etc/claude-code/managed-settings.json',
  ]
  let mode: PermissionMode = 'default'
  for (const file of files) {
    try {
      const settings = JSON.parse(readFileSync(file, 'utf8')) as {
        permissions?: { defaultMode?: unknown }
      }
      const value = settings.permissions?.defaultMode
      if (isPermissionMode(value)) mode = value
    } catch {
      // Missing or unreadable: that source just doesn't set it.
    }
  }
  return mode
}

/**
 * A tool call waiting on a tap.
 *
 * The exact event that announced it is kept so a reattaching phone can be sent
 * the identical thing — a permission card or a question card, whichever it was.
 */
interface PendingPermission {
  id: string
  name: string
  /** Replayed verbatim to any phone that (re)attaches. */
  event: OutEvent
  input: Record<string, unknown>
  resolve: (result: PermissionResult) => void
}

/**
 * Unbounded async queue that feeds the SDK's streaming-input mode.
 *
 * Streaming input is what makes follow-up turns, interrupt(), canUseTool and
 * every control request below available at all — a plain string prompt gives
 * none of those.
 */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false

  push(message: SDKUserMessage): void {
    this.items.push(message)
    this.wake?.()
    this.wake = null
  }

  close(): void {
    this.closed = true
    this.wake?.()
    this.wake = null
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      while (this.items.length > 0) {
        yield this.items.shift()!
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }
}

/**
 * How long a request waits for a tap.
 *
 * The CLI waits indefinitely, and so should this: the phone is in a pocket
 * with the screen off, which is the normal case rather than an abandoned one.
 * The cap only exists so a forgotten request cannot pin a claude subprocess
 * forever.
 */
const PERMISSION_TIMEOUT_MS = 24 * 60 * 60 * 1000
/**
 * How long a runner outlives its last phone. Long enough to survive a page
 * reload, a tunnel blip, or the screen locking; short enough that browsing
 * through projects doesn't leave a pile of claude subprocesses behind.
 */
const IDLE_REAP_MS = 2 * 60 * 1000

export class Runner {
  readonly project: Project
  sessionId: string | null
  busy = false
  /**
   * Applied at start, or live via a control request once a run exists.
   *
   * null means "not chosen": no `--permission-mode` is passed and the CLI
   * starts in whatever `permissions.defaultMode` the settings say — exactly what
   * running `claude` in a terminal does. Always passing 'default' here used to
   * override a configured auto mode.
   */
  mode: PermissionMode | null = null
  /** null means "whatever the CLI defaults to". */
  model: string | null = null
  /**
   * Effort picked on the phone, re-applied if the claude process restarts.
   * null means "not chosen": the CLI uses the saved per-model default.
   */
  effort: EffortLevel | null = null
  /** What the CLI reports it will actually send, when we have asked it. */
  liveEffort: EffortLevel | null = null
  /** Reported by the init message once a run is alive. */
  liveModel: string | null = null

  private input = new InputQueue()
  private q: Query | null = null
  private pump: Promise<void> | null = null
  private readonly sinks = new Set<Sink>()
  private readonly pending = new Map<string, PendingPermission>()
  private disposed = false
  private reapTimer: NodeJS.Timeout | null = null
  private onReap: (() => void) | null = null
  private lastInit: OutEvent | null = null
  /**
   * Background subagents and shells still running in the claude process.
   *
   * A finished turn does not mean finished work: the CLI wakes the model again
   * when a background task completes. Reaping the process in between kills
   * that work, and the reaper only gets its chance when no phone is attached —
   * that is, exactly when the screen is off.
   */
  private bgTasks: BackgroundTask[] = []
  /**
   * Whether this CLI emits session_state_changed. Once it does, that alone
   * drives `busy`: a `result` can arrive while held-back background work is
   * still going, so treating it as "done" would show "ready" too early.
   */
  private sawSessionState = false

  constructor(project: Project, sessionId: string | null) {
    this.project = project
    this.sessionId = sessionId
  }

  /** The mode to show: the live one if known, else what the CLI will pick. */
  get displayMode(): PermissionMode {
    return this.mode ?? configuredDefaultMode(this.project.path)
  }

  /** Busy, waiting on a tap, or running background work: not safe to reap. */
  get active(): boolean {
    return this.busy || this.pending.size > 0 || this.bgTasks.length > 0
  }

  /** Called by the registry so a reaped runner also drops out of the map. */
  setReapHandler(fn: () => void): void {
    this.onReap = fn
  }

  /**
   * Attach a phone.
   *
   * Deliberately does NOT replay past messages: the transcript on disk is the
   * source of truth for anything already committed, and replaying here would
   * duplicate every message the client just loaded from it. Only live state —
   * session metadata, the busy flag and any tool call still waiting on a tap.
   */
  attach(sink: Sink): () => void {
    this.sinks.add(sink)
    this.cancelReap()
    if (this.sessionId) sink({ t: 'session', sessionId: this.sessionId })
    if (this.lastInit) sink(this.lastInit)
    // After lastInit, whose permissionMode can be stale once the mode changed.
    sink({ t: 'mode', mode: this.displayMode })
    sink({ t: 'background', tasks: this.bgTasks })
    sink({ t: 'effort', current: this.liveEffort ?? this.effort })
    for (const p of this.pending.values()) sink(p.event)
    sink({ t: 'busy', busy: this.busy })
    return () => {
      this.sinks.delete(sink)
      this.maybeScheduleReap()
    }
  }

  get clientCount(): number {
    return this.sinks.size
  }

  /** How many tool calls are blocked waiting for an answer from the phone. */
  get pendingCount(): number {
    return this.pending.size
  }

  private cancelReap(): void {
    if (this.reapTimer) {
      clearTimeout(this.reapTimer)
      this.reapTimer = null
    }
  }

  /**
   * Wind the run down once nobody is watching. A turn that is still in flight is
   * left alone — finishing the work while the phone is away is the whole point —
   * and gets reaped when it completes with no client attached.
   */
  private maybeScheduleReap(): void {
    this.cancelReap()
    if (this.disposed || this.sinks.size > 0 || this.active) return
    this.reapTimer = setTimeout(() => {
      this.reapTimer = null
      if (this.sinks.size > 0 || this.active) return
      this.onReap?.()
    }, IDLE_REAP_MS)
    this.reapTimer.unref()
  }

  private emit(event: OutEvent): void {
    for (const sink of this.sinks) {
      try {
        sink(event)
      } catch {
        // A dead socket must not take down the run.
      }
    }
  }

  private buildOptions(): Options {
    return {
      cwd: this.project.path,
      ...(this.sessionId ? { resume: this.sessionId } : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      // Omitted unless chosen on the phone, so the CLI applies the configured
      // permissions.defaultMode (auto, here) the same way the terminal does.
      ...(this.mode ? { permissionMode: this.mode } : {}),
      includePartialMessages: true,
      // The SDK defaults to [] (isolation mode), which would skip the global
      // ~/.claude/CLAUDE.md and per-project CLAUDE.md. Loading them makes the
      // phone behave the same as the terminal.
      settingSources: ['user', 'project', 'local'],
      pathToClaudeCodeExecutable: config.claudeBin,
      env: {
        ...process.env,
        // Opt-in: session_state_changed is the authoritative "turn is over"
        // signal, and the only one that covers turns the CLI starts by itself
        // when a background task finishes.
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      },
      canUseTool: (name, input, options) => this.requestPermission(name, input, options),
      stderr: (data) => {
        const text = data.trim()
        if (text) console.error(`[claude:${this.project.name}] ${text}`)
      },
    }
  }

  private requestPermission(
    name: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; title?: string; decisionReason?: string },
  ): Promise<PermissionResult> {
    const { signal } = options
    const id = randomUUID()
    const questions = name === 'AskUserQuestion' ? parseQuestions(input) : null

    return new Promise<PermissionResult>((resolve) => {
      let settled = false
      const finish = (result: PermissionResult, decision: Verdict): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.pending.delete(id)
        this.emit({ t: 'permission_resolved', id, decision })
        resolve(result)
        // A request was the only thing keeping an unwatched run alive.
        this.maybeScheduleReap()
      }

      const timer = setTimeout(() => {
        finish(
          { behavior: 'deny', message: 'No answer from the phone within 24 hours.' },
          'expired',
        )
      }, PERMISSION_TIMEOUT_MS)
      timer.unref()

      // The CLI withdrew the request — Stop was pressed, or it settled the call
      // itself. Not the user's "no", so not shown as one.
      const onAbort = (): void => {
        finish({ behavior: 'deny', message: 'Interrupted.' }, 'cancelled')
      }
      signal.addEventListener('abort', onAbort, { once: true })

      // AskUserQuestion gets its own card so the options are tappable. Without
      // this it arrives as an opaque tool chip that cannot be answered at all.
      const event: OutEvent = questions
        ? { t: 'question', id, questions }
        : {
            t: 'permission',
            id,
            name,
            summary: summarize(name, input),
            input: safeJson(input),
            ...(options.title ? { title: options.title } : {}),
            ...(options.decisionReason ? { reason: options.decisionReason } : {}),
          }

      this.pending.set(id, {
        id,
        name,
        event,
        input,
        resolve: (result) => finish(result, result.behavior === 'allow' ? 'allow' : 'deny'),
      })

      this.emit(event)
    })
  }

  /**
   * Answer a permission card.
   *
   * `mode` only means something for ExitPlanMode, where approving the plan
   * also picks the mode the work continues in — the CLI's "Yes, and use auto
   * mode" / "auto-accept edits" / "manually approve edits".
   */
  decide(id: string, decision: 'allow' | 'deny', mode?: PermissionMode): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    if (decision === 'allow') {
      const setMode = p.name === 'ExitPlanMode' && mode && mode !== 'plan' ? mode : null
      // updatedInput is required on an allow; we never modify it, so echo back
      // exactly what Claude asked for.
      p.resolve({
        behavior: 'allow',
        updatedInput: p.input,
        ...(setMode
          ? { updatedPermissions: [{ type: 'setMode', mode: setMode, destination: 'session' }] }
          : {}),
      })
      if (setMode) {
        this.mode = setMode
        this.emit({ t: 'mode', mode: setMode })
      }
    } else {
      p.resolve({ behavior: 'deny', message: 'The user denied this from their phone.' })
    }
    return true
  }

  /**
   * Deliver answers to an AskUserQuestion call.
   *
   * Current SDKs take the answers as part of an *allow*: they go back in
   * `updatedInput.answers`, keyed by question text, multi-select joined with
   * ", ". The tool then returns a real result, exactly as if the question had
   * been answered in the terminal. (Older SDKs had no such field, which is why
   * this used to smuggle the answers back on a deny message.)
   */
  answer(id: string, answers: PhoneAnswer[]): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    const chosen = answers.filter((a) => a.question && a.selected.length > 0)

    if (chosen.length === 0) {
      p.resolve({
        behavior: 'deny',
        message:
          'The user dismissed the question without choosing. Ask again as plain text if you still need an answer.',
      })
      return true
    }

    p.resolve({
      behavior: 'allow',
      updatedInput: {
        ...p.input,
        answers: Object.fromEntries(chosen.map((a) => [a.question, a.selected.join(', ')])),
      },
    })
    return true
  }

  /**
   * Bring the claude subprocess up without sending a turn.
   *
   * Control requests (command list, model list, live mode changes) only work
   * against a live run, so anything that needs one calls this first. Starting is
   * cheap and the idle reaper cleans up if the phone wanders off.
   */
  ensureStarted(): void {
    if (this.disposed) throw new Error('This conversation was closed. Reopen it to continue.')
    this.cancelReap()
    if (!this.q) this.start()
  }

  /**
   * Queue a turn, starting the underlying run if it isn't alive.
   *
   * `content` may be a plain string or an array of content blocks — the latter is
   * how attached images reach the model as real vision input.
   */
  send(content: string | unknown[]): void {
    this.ensureStarted()
    this.setBusy(true)
    this.input.push({
      type: 'user',
      message: { role: 'user', content: content as never },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? '',
    })
  }

  /**
   * Change the permission mode.
   *
   * Applied immediately when a run is live; otherwise it is remembered and used
   * as the starting mode, so switching to plan mode before the first prompt does
   * what you'd expect.
   */
  async setMode(mode: PermissionMode): Promise<void> {
    this.mode = mode
    if (this.q) await this.q.setPermissionMode(mode)
    this.emit({ t: 'mode', mode })
  }

  async setModel(model: string | null): Promise<void> {
    this.model = model
    if (this.q) await this.q.setModel(model ?? undefined)
    if (model) this.liveModel = model
    this.emit({
      t: 'init',
      model: this.liveModel ?? model ?? 'default',
      permissionMode: this.displayMode,
      version: '',
      toolCount: 0,
    })
    // Effort is saved per model, and a model without the current level gets
    // a downgrade — either way the chip may now be wrong.
    await this.refreshEffort()
  }

  /**
   * Set the reasoning effort, the way `/effort` does in the terminal: the
   * running session switches immediately, and the level is saved as this
   * model's default for new sessions. `max` is session-only there and here.
   */
  async setEffort(level: EffortLevel): Promise<void> {
    this.ensureStarted()
    const q = this.q
    if (!q) return
    this.effort = level
    await q.applyFlagSettings({ effortLevel: level })
    if (level !== 'max') await q.updateSettings('userSettings', { effortLevel: level })
    this.liveEffort = level
    this.emit({ t: 'effort', current: level })
    // The CLI may clamp it (org cap, maxEffortLevel, model support).
    await this.refreshEffort()
  }

  /** Ask the CLI what effort it will really send, and tell the phone. */
  async refreshEffort(): Promise<EffortLevel | null> {
    const q = this.q as (Query & WithSettings) | null
    if (!q?.getSettings) return this.liveEffort
    try {
      const effort = (await q.getSettings()).applied?.effort
      const next = isEffortLevel(effort) ? effort : null
      if (next !== this.liveEffort) {
        this.liveEffort = next
        this.emit({ t: 'effort', current: next })
      }
    } catch {
      // A CLI without get_settings: keep what we have.
    }
    return this.liveEffort
  }

  /** Current effort plus the levels the current model accepts, for the picker. */
  async effortInfo(): Promise<{ current: EffortLevel | null; levels: EffortLevel[]; model: string | null }> {
    this.ensureStarted()
    const q = this.q
    if (!q) return { current: this.effort, levels: EFFORT_LEVELS, model: this.liveModel }
    const [models, current] = await Promise.all([q.supportedModels(), this.refreshEffort()])
    // The live model id ("claude-opus-5-5") need not be in the list, which
    // also has aliases; fall back to the entry the session is actually using.
    const wanted = this.model ?? this.liveModel
    const info =
      models.find((m) => m.value === wanted) ??
      models.find((m) => m.value === this.liveModel) ??
      (this.model ? undefined : models.find((m) => m.value === 'default'))
    const levels =
      info?.supportsEffort === false
        ? []
        : (info?.supportedEffortLevels?.filter(isEffortLevel) ?? EFFORT_LEVELS)
    return { current: current ?? this.effort, levels, model: this.liveModel }
  }

  async commands(): Promise<SlashCommand[]> {
    this.ensureStarted()
    return this.q ? await this.q.supportedCommands() : []
  }

  async models(): Promise<ModelInfo[]> {
    this.ensureStarted()
    return this.q ? await this.q.supportedModels() : []
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return
    this.busy = busy
    this.emit({ t: 'busy', busy })
    if (busy) this.cancelReap()
    else this.maybeScheduleReap()
  }

  private start(): void {
    this.input = new InputQueue()
    // The background-task level is per process: a new one starts empty.
    this.bgTasks = []
    this.sawSessionState = false
    const q = query({ prompt: this.input, options: this.buildOptions() })
    this.q = q
    this.pump = this.consume(q).catch((err: unknown) => {
      this.emit({ t: 'error', message: err instanceof Error ? err.message : String(err) })
    })
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const message of q) {
        if (message.session_id && message.session_id !== this.sessionId) {
          this.sessionId = message.session_id
          this.emit({ t: 'session', sessionId: message.session_id })
        }

        // Subagent traffic carries the id of the Agent call that spawned it.
        // The CLI keeps that inside the agent's own panel, and the transcript
        // marks it sidechain so a reload drops it anyway; rendering it live
        // only splices another conversation into this one until the next load.
        if (
          'parent_tool_use_id' in message &&
          message.parent_tool_use_id &&
          (message.type === 'assistant' || message.type === 'user' || message.type === 'stream_event')
        ) {
          continue
        }

        switch (message.type) {
          case 'system': {
            if (message.subtype === 'init') {
              this.liveModel = message.model
              this.mode = message.permissionMode
              const init: OutEvent = {
                t: 'init',
                model: message.model,
                permissionMode: message.permissionMode,
                version: message.claude_code_version,
                toolCount: message.tools.length,
              }
              // Kept so a phone attaching later still learns the model.
              this.lastInit = init
              this.emit(init)
              this.emit({ t: 'mode', mode: message.permissionMode })
              void this.refreshEffort()
            } else if (message.subtype === 'status') {
              // Mode changes the CLI makes by itself — leaving plan mode, or
              // auto mode turning out to be unavailable — arrive here.
              if (message.permissionMode && message.permissionMode !== this.mode) {
                this.mode = message.permissionMode
                this.emit({ t: 'mode', mode: message.permissionMode })
              }
            } else if (message.subtype === 'background_tasks_changed') {
              // Level signal with replace semantics, per the SDK docs.
              this.bgTasks = message.tasks.map((t) => ({
                id: t.task_id,
                type: t.task_type,
                description: t.description,
              }))
              this.emit({ t: 'background', tasks: this.bgTasks })
              this.maybeScheduleReap()
            } else if (message.subtype === 'session_state_changed') {
              this.sawSessionState = true
              // 'running' also covers turns nobody typed: the CLI starting one
              // because a background task finished.
              this.setBusy(message.state !== 'idle')
            }
            break
          }

          case 'tool_progress': {
            // The only signal for "still chewing on one long tool call".
            this.emit({
              t: 'progress',
              tool: message.tool_name,
              seconds: message.elapsed_time_seconds,
            })
            break
          }

          case 'stream_event': {
            const event = message.event
            if (event.type === 'content_block_delta') {
              const delta = event.delta
              if (delta.type === 'text_delta' && delta.text) {
                this.emit({ t: 'partial', text: delta.text })
              }
            } else if (
              event.type === 'content_block_start' &&
              event.content_block.type === 'thinking'
            ) {
              this.emit({ t: 'thinking' })
            }
            break
          }

          case 'assistant':
          case 'user': {
            const rendered = convert(message as unknown as Record<string, unknown>)
            if (rendered) this.emit({ t: 'message', message: rendered })
            break
          }

          case 'result': {
            this.emit({
              t: 'result',
              isError: message.is_error,
              costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : null,
              durationMs: typeof message.duration_ms === 'number' ? message.duration_ms : null,
              text: message.subtype === 'success' ? message.result : message.subtype,
            })
            // Without session states (older CLI), result is the best end signal.
            if (!this.sawSessionState) this.setBusy(false)
            // A typed /effort or /model changes it without telling us.
            void this.refreshEffort()
            break
          }

          default:
            break
        }
      }
    } finally {
      // The generator finished: the claude subprocess is gone. Drop it so the
      // next prompt starts a fresh one, resuming the session we captured. Its
      // background tasks died with it.
      this.q = null
      if (this.bgTasks.length > 0) {
        this.bgTasks = []
        this.emit({ t: 'background', tasks: [] })
      }
      this.busy = false
      this.emit({ t: 'busy', busy: false })
      this.maybeScheduleReap()
    }
  }

  async interrupt(): Promise<void> {
    if (!this.q) return
    try {
      await this.q.interrupt()
    } catch (err) {
      this.emit({
        t: 'error',
        message: `Interrupt failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.cancelReap()
    for (const p of [...this.pending.values()]) {
      p.resolve({ behavior: 'deny', message: 'Conversation closed.' })
    }
    this.input.close()
    try {
      await this.q?.interrupt()
    } catch {
      // Already gone.
    }
    this.q = null
    await this.pump?.catch(() => undefined)
  }
}

/**
 * One runner per project.
 *
 * Two concurrent runs in the same directory would append to the same transcript
 * and race on the filesystem, so a second request re-attaches to the live run
 * instead of starting another.
 */
const runners = new Map<string, Runner>()

function runnerKey(projectId: string): string {
  return projectId
}

export function getRunner(project: Project): Runner | undefined {
  return runners.get(runnerKey(project.id))
}

export class TooManyRunners extends Error {}

export function openRunner(project: Project, sessionId: string | null): Runner {
  const key = runnerKey(project.id)
  const existing = runners.get(key)
  if (existing) return existing

  // Each runner is a claude subprocess. Without a ceiling, opening conversations
  // across many projects (or just tapping the model chip in each) can spawn one
  // per project and exhaust memory.
  if (runners.size >= config.maxRunners) {
    for (const [otherKey, other] of runners) {
      // Background work counts as busy: evicting it would kill that work.
      if (other.clientCount === 0 && !other.active) {
        runners.delete(otherKey)
        void other.dispose()
        break
      }
    }
  }
  if (runners.size >= config.maxRunners) {
    throw new TooManyRunners(
      `${config.maxRunners} conversations are already open and busy. Close one and try again.`,
    )
  }

  const runner = new Runner(project, sessionId)
  runner.setReapHandler(() => {
    // Only drop it if this is still the registered runner for the project.
    if (runners.get(key) === runner) runners.delete(key)
    void runner.dispose()
  })
  runners.set(key, runner)
  return runner
}

export async function closeRunner(project: Project): Promise<void> {
  const key = runnerKey(project.id)
  const runner = runners.get(key)
  if (!runner) return
  runners.delete(key)
  await runner.dispose()
}

export function activeRunners(): Runner[] {
  return [...runners.values()]
}

export async function shutdownRunners(): Promise<void> {
  await Promise.all([...runners.values()].map((r) => r.dispose()))
  runners.clear()
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '{}'
  } catch {
    return '{}'
  }
}

/**
 * Pull the questions out of an AskUserQuestion tool input.
 *
 * Returns null if the shape isn't what we expect, in which case the call falls
 * back to an ordinary permission card rather than rendering an empty form.
 */
function parseQuestions(input: Record<string, unknown>): PhoneQuestion[] | null {
  const raw = input.questions
  if (!Array.isArray(raw) || raw.length === 0) return null

  const questions: PhoneQuestion[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const q = item as Record<string, unknown>
    const text = typeof q.question === 'string' ? q.question : null
    if (!text) continue

    const options: { label: string; description: string }[] = []
    if (Array.isArray(q.options)) {
      for (const opt of q.options) {
        if (!opt || typeof opt !== 'object') continue
        const o = opt as Record<string, unknown>
        if (typeof o.label !== 'string') continue
        options.push({
          label: o.label,
          description: typeof o.description === 'string' ? o.description : '',
        })
      }
    }
    if (options.length === 0) continue

    questions.push({
      question: text,
      header: typeof q.header === 'string' ? q.header : '',
      multiSelect: q.multiSelect === true,
      options,
    })
  }

  return questions.length > 0 ? questions : null
}

/** Short, human-readable description of what a tool is about to do. */
function summarize(name: string, input: Record<string, unknown>): string {
  const str = (key: string): string | null => (typeof input[key] === 'string' ? (input[key] as string) : null)
  switch (name) {
    case 'Bash':
      return str('command') ?? ''
    case 'Read':
    case 'Write':
    case 'Edit':
      return str('file_path') ?? ''
    case 'Glob':
      return str('pattern') ?? ''
    case 'Grep':
      return [str('pattern'), str('path')].filter(Boolean).join('  in  ')
    case 'WebFetch':
      return str('url') ?? ''
    case 'WebSearch':
      return str('query') ?? ''
    default: {
      const flat = safeJson(input).replace(/\s+/g, ' ').trim()
      return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat
    }
  }
}
