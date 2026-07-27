import { randomUUID } from 'node:crypto'

import {
  query,
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
  | { t: 'permission'; id: string; name: string; summary: string; input: string }
  | { t: 'question'; id: string; questions: PhoneQuestion[] }
  | { t: 'permission_resolved'; id: string; decision: 'allow' | 'deny' }
  | { t: 'result'; isError: boolean; costUsd: number | null; durationMs: number | null; text: string | null }
  | { t: 'error'; message: string }
  | { t: 'notice'; message: string }
  // Live session metadata, so the phone can show what it is actually talking to.
  | { t: 'init'; model: string; permissionMode: string; version: string; toolCount: number }
  | { t: 'progress'; tool: string; seconds: number }
  | { t: 'mode'; mode: PermissionMode }
  | { t: 'commands'; commands: SlashCommand[] }
  | { t: 'models'; models: ModelInfo[]; current: string | null }

export type Sink = (event: OutEvent) => void

export const PERMISSION_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
]

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as string[]).includes(value)
}

/**
 * A tool call waiting on a tap.
 *
 * The exact event that announced it is kept so a reattaching phone can be sent
 * the identical thing — a permission card or a question card, whichever it was.
 */
interface PendingPermission {
  id: string
  /** Replayed verbatim to any phone that (re)attaches. */
  event: OutEvent
  input: string
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

const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000
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
  /** Applied at start, or live via a control request once a run exists. */
  mode: PermissionMode = 'default'
  /** null means "whatever the CLI defaults to". */
  model: string | null = null
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

  constructor(project: Project, sessionId: string | null) {
    this.project = project
    this.sessionId = sessionId
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
    sink({ t: 'mode', mode: this.mode })
    if (this.lastInit) sink(this.lastInit)
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
    if (this.disposed || this.sinks.size > 0 || this.busy) return
    this.reapTimer = setTimeout(() => {
      this.reapTimer = null
      if (this.sinks.size > 0 || this.busy) return
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
      permissionMode: this.mode,
      includePartialMessages: true,
      // The SDK defaults to [] (isolation mode), which would skip the global
      // ~/.claude/CLAUDE.md and per-project CLAUDE.md. Loading them makes the
      // phone behave the same as the terminal.
      settingSources: ['user', 'project', 'local'],
      pathToClaudeCodeExecutable: config.claudeBin,
      canUseTool: (name, input, { signal }) => this.requestPermission(name, input, signal),
      stderr: (data) => {
        const text = data.trim()
        if (text) console.error(`[claude:${this.project.name}] ${text}`)
      },
    }
  }

  private requestPermission(
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const id = randomUUID()
    const serialized = safeJson(input)
    const questions = name === 'AskUserQuestion' ? parseQuestions(input) : null

    return new Promise<PermissionResult>((resolve) => {
      let settled = false
      const finish = (result: PermissionResult, decision: 'allow' | 'deny'): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.pending.delete(id)
        this.emit({ t: 'permission_resolved', id, decision })
        resolve(result)
      }

      const timer = setTimeout(() => {
        finish(
          { behavior: 'deny', message: 'No answer from the phone within 10 minutes.' },
          'deny',
        )
      }, PERMISSION_TIMEOUT_MS)

      const onAbort = (): void => {
        finish({ behavior: 'deny', message: 'Interrupted.' }, 'deny')
      }
      signal.addEventListener('abort', onAbort, { once: true })

      // AskUserQuestion gets its own card so the options are tappable. Without
      // this it arrives as an opaque tool chip that cannot be answered at all.
      const event: OutEvent = questions
        ? { t: 'question', id, questions }
        : { t: 'permission', id, name, summary: summarize(name, input), input: serialized }

      this.pending.set(id, {
        id,
        event,
        input: serialized,
        resolve: (result) => finish(result, result.behavior === 'allow' ? 'allow' : 'deny'),
      })

      this.emit(event)
    })
  }

  decide(id: string, decision: 'allow' | 'deny', originalInput?: Record<string, unknown>): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    if (decision === 'allow') {
      // updatedInput is required on an allow; we never modify it, so echo back
      // exactly what Claude asked for.
      p.resolve({ behavior: 'allow', updatedInput: originalInput ?? parseJson(p.input) })
    } else {
      p.resolve({ behavior: 'deny', message: 'The user denied this from their phone.' })
    }
    return true
  }

  /**
   * Deliver answers to an AskUserQuestion call.
   *
   * canUseTool can only allow or deny — it cannot supply a tool *result* — so the
   * answers ride back on the deny message. Claude reads that text and carries on
   * as if the question had been answered, which it has.
   */
  answer(id: string, answers: PhoneAnswer[]): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    const lines = answers
      .filter((a) => a.selected.length > 0)
      .map((a) => `- ${a.question}: ${a.selected.join(', ')}`)

    if (lines.length === 0) {
      p.resolve({
        behavior: 'deny',
        message:
          'The user dismissed the question without choosing. Ask again as plain text if you still need an answer.',
      })
      return true
    }

    p.resolve({
      behavior: 'deny',
      message: [
        'The user answered from their phone. pocket-claude cannot return a real',
        'AskUserQuestion result, so the answers are delivered here instead — treat',
        'them as the user’s chosen answers and continue. Do not call',
        'AskUserQuestion again for these questions.',
        '',
        ...lines,
      ].join('\n'),
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
    this.busy = true
    this.emit({ t: 'busy', busy: true })
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
      permissionMode: this.mode,
      version: '',
      toolCount: 0,
    })
  }

  async commands(): Promise<SlashCommand[]> {
    this.ensureStarted()
    return this.q ? await this.q.supportedCommands() : []
  }

  async models(): Promise<ModelInfo[]> {
    this.ensureStarted()
    return this.q ? await this.q.supportedModels() : []
  }

  private start(): void {
    this.input = new InputQueue()
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
            this.busy = false
            this.emit({
              t: 'result',
              isError: message.is_error,
              costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : null,
              durationMs: typeof message.duration_ms === 'number' ? message.duration_ms : null,
              text: message.subtype === 'success' ? message.result : message.subtype,
            })
            this.emit({ t: 'busy', busy: false })
            this.maybeScheduleReap()
            break
          }

          default:
            break
        }
      }
    } finally {
      // The generator finished: the claude subprocess is gone. Drop it so the
      // next prompt starts a fresh one, resuming the session we captured.
      this.q = null
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

export function openRunner(project: Project, sessionId: string | null): Runner {
  const key = runnerKey(project.id)
  const existing = runners.get(key)
  if (existing) return existing
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

function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
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
