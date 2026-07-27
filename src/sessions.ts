import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'

import { claudeProjectsDir } from './config.js'

/**
 * Everything we can learn about one conversation without rendering it.
 *
 * Titles come from the `ai-title` entry Claude Code writes into the transcript
 * (it re-emits it as the conversation evolves, so the last one wins). Falling
 * back through lastPrompt and then the first user message means a session that
 * is too young to have a title still shows something meaningful.
 */
export interface SessionMeta {
  sessionId: string
  file: string
  cwd: string | null
  title: string
  preview: string | null
  lastActivity: number
  entryCount: number
  sizeBytes: number
  /** Model from the most recent assistant entry, so the UI can show it cold. */
  model: string | null
}

interface CacheEntry<T> {
  key: string
  value: T
}

const metaCache = new Map<string, CacheEntry<SessionMeta>>()
const cwdCache = new Map<string, CacheEntry<string | null>>()

function cacheKey(mtimeMs: number, size: number): string {
  return `${mtimeMs}:${size}`
}

function truncate(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** Pull plain text out of an Anthropic message `content`, which may be a string or a block array. */
function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content || null
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const t = (block as { text?: unknown }).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  return parts.length ? parts.join('\n') : null
}

async function* jsonlLines(file: string): AsyncGenerator<Record<string, unknown>> {
  const stream = createReadStream(file, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line) continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (parsed && typeof parsed === 'object') yield parsed as Record<string, unknown>
      } catch {
        // A transcript being appended to right now can end in a partial line.
        // Skipping it is correct; the next poll picks up the complete version.
      }
    }
  } finally {
    rl.close()
    stream.destroy()
  }
}

/**
 * Read just enough of a transcript to learn which directory it belongs to.
 *
 * The `~/.claude/projects/` directory name is NOT reversible: it replaces both
 * `/` and `_` with `-`, so `academic_projects` and `academic-projects` encode
 * identically. The `cwd` field on any user/assistant entry is authoritative,
 * so we scan the head of the file for one instead of guessing.
 */
export async function readTranscriptCwd(file: string): Promise<string | null> {
  const info = await stat(file)
  const key = cacheKey(info.mtimeMs, info.size)
  const hit = cwdCache.get(file)
  if (hit && hit.key === key) return hit.value

  let found: string | null = null
  let scanned = 0
  for await (const entry of jsonlLines(file)) {
    if (typeof entry.cwd === 'string' && entry.cwd) {
      found = entry.cwd
      break
    }
    if (++scanned > 400) break
  }
  cwdCache.set(file, { key, value: found })
  return found
}

/** Full metadata for one transcript file. Cached on (mtime, size). */
export async function readSessionMeta(file: string): Promise<SessionMeta> {
  const info = await stat(file)
  const key = cacheKey(info.mtimeMs, info.size)
  const hit = metaCache.get(file)
  if (hit && hit.key === key) return hit.value

  let aiTitle: string | null = null
  let lastPrompt: string | null = null
  let firstUser: string | null = null
  let sessionId: string | null = null
  let cwd: string | null = null
  let lastTs = 0
  let entryCount = 0
  let model: string | null = null

  for await (const entry of jsonlLines(file)) {
    entryCount++
    const type = entry.type

    if (type === 'assistant') {
      const m = (entry.message as { model?: unknown } | undefined)?.model
      if (typeof m === 'string' && m) model = m
    }

    if (typeof entry.sessionId === 'string' && !sessionId) sessionId = entry.sessionId
    if (typeof entry.cwd === 'string' && !cwd) cwd = entry.cwd
    if (typeof entry.timestamp === 'string') {
      const ms = Date.parse(entry.timestamp)
      if (Number.isFinite(ms) && ms > lastTs) lastTs = ms
    }

    if (type === 'ai-title' && typeof entry.aiTitle === 'string') {
      aiTitle = entry.aiTitle
    } else if (type === 'last-prompt' && typeof entry.lastPrompt === 'string') {
      lastPrompt = entry.lastPrompt
    } else if (type === 'user' && !firstUser && entry.isMeta !== true && entry.isSidechain !== true) {
      const message = entry.message as { content?: unknown } | undefined
      const text = textOf(message?.content)
      if (text) firstUser = text
    }
  }

  const fallbackId = path.basename(file, '.jsonl')
  const value: SessionMeta = {
    sessionId: sessionId ?? fallbackId,
    file,
    cwd,
    title:
      aiTitle?.trim() ||
      (lastPrompt ? truncate(lastPrompt) : null) ||
      (firstUser ? truncate(firstUser) : null) ||
      fallbackId,
    preview: lastPrompt ? truncate(lastPrompt, 140) : firstUser ? truncate(firstUser, 140) : null,
    lastActivity: lastTs || info.mtimeMs,
    entryCount,
    sizeBytes: info.size,
    model,
  }
  metaCache.set(file, { key, value })
  return value
}

/** Absolute paths of every `*.jsonl` transcript in a Claude project directory. */
export async function transcriptFiles(historyDir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(historyDir, { withFileTypes: true })
  } catch {
    return []
  }
  // Filter to files ending in .jsonl — these directories also contain
  // subdirectories such as `memory/`.
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => path.join(historyDir, e.name))
}

/** Conversations for one project, newest first. */
export async function listSessions(historyDirName: string): Promise<SessionMeta[]> {
  const dir = path.join(claudeProjectsDir, historyDirName)
  const files = await transcriptFiles(dir)
  const metas = await Promise.all(
    files.map((f) => readSessionMeta(f).catch(() => null)),
  )
  return metas
    .filter((m): m is SessionMeta => m !== null && m.entryCount > 0)
    .sort((a, b) => b.lastActivity - a.lastActivity)
}

export { jsonlLines }
