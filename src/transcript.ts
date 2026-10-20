import path from 'node:path'

import { claudeProjectsDir } from './config.js'
import { jsonlLines } from './sessions.js'

/**
 * The wire shape the phone renders. Deliberately flat and small — a raw
 * transcript entry carries a lot the UI has no use for.
 */
export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mime: string }
  | { kind: 'thinking'; text: string }
  /** `title`: the call's own plain-language description (Bash has one), for the row label. */
  | { kind: 'tool_use'; name: string; summary: string; input?: string; id?: string; title?: string }
  /** `toolUseId` pairs a result with its call, so the phone can show them as one row. */
  | { kind: 'tool_result'; summary: string; isError: boolean; toolUseId?: string }
  /** A harness event the CLI shows as a status line rather than a message. */
  | { kind: 'note'; label: string; summary: string; detail?: string; isError?: boolean }

export interface RenderedMessage {
  role: 'user' | 'assistant'
  blocks: Block[]
  ts: number | null
  uuid: string | null
}

export interface TranscriptPage {
  messages: RenderedMessage[]
  /** True when older messages were withheld and can be requested. */
  hasEarlier: boolean
  totalMessages: number
}

/** Entry types that carry no conversational content. */
const SKIP_TYPES = new Set([
  'attachment',
  'ai-title',
  'last-prompt',
  'mode',
  'permission-mode',
  'file-history-snapshot',
  'system',
  'queue-operation',
])

const MAX_TOOL_INPUT = 600
const MAX_TOOL_RESULT = 800

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`
}

function stringifyInput(input: unknown): string {
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input, null, 2) ?? ''
  } catch {
    return ''
  }
}

/**
 * One-line description of a tool call, chosen per tool so the chip is useful on
 * a narrow screen rather than showing raw JSON.
 */
function summarizeToolUse(name: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>
  const str = (key: string): string | null => (typeof obj[key] === 'string' ? (obj[key] as string) : null)

  switch (name) {
    case 'Bash':
      return str('command') ?? ''
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return str('file_path') ?? str('notebook_path') ?? ''
    case 'Glob':
      return str('pattern') ?? ''
    case 'Grep':
      return [str('pattern'), str('path')].filter(Boolean).join('  in  ')
    case 'WebFetch':
      return str('url') ?? ''
    case 'WebSearch':
      return str('query') ?? ''
    case 'Task':
    case 'Agent':
      return str('description') ?? str('subagent_type') ?? ''
    case 'Skill':
      return str('skill') ?? ''
    case 'TodoWrite':
    case 'TaskCreate':
      return str('subject') ?? ''
    default: {
      const flat = stringifyInput(input).replace(/\s+/g, ' ').trim()
      return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat
    }
  }
}

/** Bash and PowerShell calls describe themselves; that reads better on a phone than the command. */
function toolTitle(name: string, input: unknown): string | null {
  if (name !== 'Bash' && name !== 'PowerShell') return null
  const description = (input as { description?: unknown } | null)?.description
  return typeof description === 'string' && description.trim() ? description.trim() : null
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return stringifyInput(content)
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: string; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'image') parts.push('[image]')
  }
  return parts.join('\n')
}

const MAX_NOTE_DETAIL = 4000

function tag(text: string, name: string): string | null {
  // Attributes allowed: `<agent-message from="…">`.
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(text)
  return match ? match[1]!.trim() : null
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

function note(label: string, summary: string, detail?: string, isError = false): Block {
  return {
    kind: 'note',
    label,
    summary,
    ...(detail ? { detail: clip(detail, MAX_NOTE_DETAIL) } : {}),
    ...(isError ? { isError } : {}),
  }
}

/**
 * User entries the person never typed.
 *
 * Current CLIs put a lot through the user role — background task results,
 * compaction summaries, slash commands and `!` shell runs, messages from other
 * sessions — mostly wrapped in XML-ish tags. Rendered as-is they show up as
 * raw markup in a bubble that looks as if you had sent it. The CLI shows them
 * as status lines; so does this.
 *
 * Returns undefined when the entry is ordinary input, null to drop it.
 */
function harnessUserEntry(
  entry: Record<string, unknown>,
  content: unknown,
  ts: number | null,
  uuid: string | null,
): RenderedMessage | null | undefined {
  let text: string
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    if (content.some((b) => (b as { type?: unknown } | null)?.type === 'tool_result')) return undefined
    text = content
      .map((b) => {
        const block = b as { type?: unknown; text?: unknown } | null
        return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
      })
      .join('\n')
  } else return undefined

  const as = (role: 'user' | 'assistant', block: Block): RenderedMessage => ({
    role,
    blocks: [block],
    ts,
    uuid,
  })
  const origin = (entry.origin ?? null) as { kind?: unknown } | null
  const trimmed = text.trimStart()

  if (origin?.kind === 'task-notification' || trimmed.startsWith('<task-notification>')) {
    const status = tag(text, 'status') ?? 'done'
    const summary = tag(text, 'summary') ?? `Background task ${status}`
    const result = tag(text, 'result') ?? undefined
    return as('assistant', note('background', summary, result, status === 'failed'))
  }
  if (entry.isCompactSummary === true) {
    return as('assistant', note('compacted', 'Earlier conversation summarized', text))
  }
  if (origin?.kind === 'peer') {
    const body = tag(text, 'agent-message') ?? text
    const report = body.replace(/^\[Subagent hand-back\][^\n]*\n?/, '').trim()
    return as('assistant', note('agent report', firstLine(report) || 'Report from a subagent', report))
  }
  if (typeof origin?.kind === 'string' && origin.kind !== 'human') {
    return as('assistant', note(origin.kind, firstLine(text.replace(/<[^>]+>/g, ' ')), text))
  }
  if (trimmed.startsWith('<local-command-caveat>')) return null
  if (/^(<command-message>|<command-name>)/.test(trimmed)) {
    const name = tag(text, 'command-name') ?? tag(text, 'command-message') ?? ''
    const args = tag(text, 'command-args') ?? ''
    const command = `${name.startsWith('/') ? '' : '/'}${name}${args ? ` ${args}` : ''}`
    return as('user', { kind: 'text', text: command })
  }
  if (trimmed.startsWith('<local-command-stdout>') || trimmed.startsWith('<local-command-stderr>')) {
    const out = tag(text, 'local-command-stdout') ?? ''
    const err = tag(text, 'local-command-stderr') ?? ''
    const body = [out, err].filter(Boolean).join('\n')
    if (!body) return null
    return as('assistant', note('output', firstLine(body), body, !out && !!err))
  }
  if (trimmed.startsWith('<bash-input>')) {
    return as('user', { kind: 'text', text: `! ${tag(text, 'bash-input') ?? ''}` })
  }
  if (trimmed.startsWith('<bash-stdout>') || trimmed.startsWith('<bash-stderr>')) {
    const out = tag(text, 'bash-stdout') ?? ''
    const err = tag(text, 'bash-stderr') ?? ''
    const body = [out, err].filter(Boolean).join('\n')
    return as('assistant', note('shell', firstLine(body) || '(no output)', body || undefined, !out && !!err))
  }
  return undefined
}

/**
 * Convert one transcript entry into a renderable message, or null to drop it.
 *
 * Also used for live SDK messages, which share the `{type, message}` shape but
 * carry no `timestamp`.
 */
export function convert(entry: Record<string, unknown>): RenderedMessage | null {
  const type = entry.type
  if (typeof type !== 'string' || SKIP_TYPES.has(type)) return null
  if (entry.isSidechain === true) return null
  if (type !== 'user' && type !== 'assistant') return null

  const message = entry.message as { role?: string; content?: unknown } | undefined
  if (!message) return null

  const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : null
  const uuid = typeof entry.uuid === 'string' ? entry.uuid : null
  const blocks: Block[] = []
  const content = message.content

  // isMeta entries are left to the filter below, which drops them — except a
  // subagent's hand-back report, which is meta but is the agent's actual
  // answer; the background-task note points at it.
  const fromPeer = (entry.origin as { kind?: unknown } | undefined)?.kind === 'peer'
  if (type === 'user' && (entry.isMeta !== true || fromPeer)) {
    const special = harnessUserEntry(entry, content, ts, uuid)
    if (special !== undefined) return special
  }

  if (typeof content === 'string') {
    if (content.trim()) blocks.push({ kind: 'text', text: content })
  } else if (Array.isArray(content)) {
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue
      const block = raw as Record<string, unknown>
      switch (block.type) {
        case 'text':
          if (typeof block.text === 'string' && block.text.trim()) {
            blocks.push({ kind: 'text', text: block.text })
          }
          break
        case 'image': {
          // The base64 payload is deliberately not forwarded — a phone photo
          // would add megabytes to every transcript load. A marker is enough.
          const source = block.source as { media_type?: unknown } | undefined
          blocks.push({
            kind: 'image',
            mime: typeof source?.media_type === 'string' ? source.media_type : 'image',
          })
          break
        }

        case 'thinking':
          if (typeof block.thinking === 'string' && block.thinking.trim()) {
            blocks.push({ kind: 'thinking', text: block.thinking })
          }
          break
        case 'tool_use': {
          const name = typeof block.name === 'string' ? block.name : 'tool'
          blocks.push({
            kind: 'tool_use',
            name,
            summary: summarizeToolUse(name, block.input),
            input: clip(stringifyInput(block.input), MAX_TOOL_INPUT),
            ...(typeof block.id === 'string' ? { id: block.id } : {}),
            ...(toolTitle(name, block.input) ? { title: toolTitle(name, block.input)! } : {}),
          })
          break
        }
        case 'tool_result':
          blocks.push({
            kind: 'tool_result',
            summary: clip(resultText(block.content).trim(), MAX_TOOL_RESULT),
            isError: block.is_error === true,
            ...(typeof block.tool_use_id === 'string' ? { toolUseId: block.tool_use_id } : {}),
          })
          break
        default:
          break
      }
    }
  }

  if (blocks.length === 0) return null

  // A user entry whose only content is a tool_result is the harness feeding
  // Claude, not the person typing — render it under the assistant's turn so the
  // conversation reads as an alternating dialogue.
  const onlyToolResults = blocks.every((b) => b.kind === 'tool_result')
  const role: 'user' | 'assistant' = type === 'user' && !onlyToolResults ? 'user' : 'assistant'

  // Drop injected context that the person never typed.
  if (type === 'user' && !onlyToolResults && entry.isMeta === true) return null

  return { role, blocks, ts, uuid }
}

/**
 * Parse a transcript for display.
 *
 * `limit` keeps the initial payload small: the biggest transcript on this box is
 * ~1 MB, which is not something to push to a phone in one response.
 */
export async function renderTranscript(
  file: string,
  opts: { limit?: number; offsetFromEnd?: number } = {},
): Promise<TranscriptPage> {
  const limit = opts.limit ?? 200
  const offsetFromEnd = opts.offsetFromEnd ?? 0

  const all: RenderedMessage[] = []
  for await (const entry of jsonlLines(file)) {
    const message = convert(entry)
    if (message) all.push(message)
  }

  const end = Math.max(0, all.length - offsetFromEnd)
  const start = Math.max(0, end - limit)
  return {
    messages: all.slice(start, end),
    hasEarlier: start > 0,
    totalMessages: all.length,
  }
}

/** Resolve a session id to its transcript path inside a known history directory. */
export function transcriptPath(historyDir: string, sessionId: string): string | null {
  // Session ids are UUIDs; refuse anything else so the id can't walk the tree.
  if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) return null
  return path.join(claudeProjectsDir, historyDir, `${sessionId}.jsonl`)
}
