import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { config } from './config.js'
import type { Project } from './projects.js'

/** Hard cap per file. A phone photo is a few MB; anything far past that is a mistake. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/** Where a project's uploads land. Hidden, and clearly ours. */
const UPLOAD_DIRNAME = '.pocket-uploads'

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export interface Attachment {
  id: string
  /** The project this was uploaded to. Ids are only usable within it. */
  projectId: string
  name: string
  mime: string
  size: number
  isImage: boolean
  /** Absolute path on disk. */
  path: string
}

/**
 * Registry of uploads that have not been attached to a prompt yet.
 *
 * Kept in memory deliberately: the client never sends a path, only an opaque id,
 * so there is no way for it to point the server at an arbitrary file.
 */
const registry = new Map<string, Attachment>()

/** Uploads are short-lived; drop anything the phone never got round to sending. */
const ATTACHMENT_TTL_MS = 6 * 60 * 60 * 1000
const created = new Map<string, number>()

function sweep(): void {
  const cutoff = Date.now() - ATTACHMENT_TTL_MS
  for (const [id, at] of created) {
    if (at < cutoff) {
      created.delete(id)
      registry.delete(id)
    }
  }
}

/**
 * Make a filename safe to place on disk.
 *
 * Everything outside a conservative set is replaced, so a name like
 * `../../.bashrc` cannot escape the upload directory even before the path
 * containment check below.
 */
function safeName(raw: string): string {
  const base = path.basename(raw || 'file')
  const cleaned = base
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80)
  return cleaned || 'file'
}

function stamp(): string {
  // No Date.now() formatting library needed; sortable and readable.
  const iso = new Date().toISOString()
  return iso.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
}

export function uploadDir(project: Project): string {
  return path.join(project.path, UPLOAD_DIRNAME)
}

export async function saveUpload(
  project: Project,
  rawName: string,
  mime: string,
  body: Buffer,
): Promise<Attachment> {
  if (body.length === 0) throw new Error('Empty file.')
  if (body.length > MAX_UPLOAD_BYTES) {
    throw new Error(`That file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`)
  }

  await enforceQuota(project, body.length)

  const dir = uploadDir(project)
  const name = safeName(rawName)
  const target = path.join(dir, `${stamp()}-${name}`)

  // Containment check: the sanitised name should make this impossible, but a
  // path that resolves outside the upload directory is never written.
  if (path.dirname(path.resolve(target)) !== path.resolve(dir)) {
    throw new Error('Refusing to write outside the upload directory.')
  }

  await mkdir(dir, { recursive: true })
  await writeFile(target, body, { mode: 0o644 })

  const attachment: Attachment = {
    id: randomUUID(),
    projectId: project.id,
    name,
    mime: mime || 'application/octet-stream',
    size: body.length,
    isImage: IMAGE_MIMES.has(mime),
    path: target,
  }
  sweep()
  registry.set(attachment.id, attachment)
  created.set(attachment.id, Date.now())
  return attachment
}

/**
 * Resolve ids to attachments, scoped to one project and consumed on use.
 *
 * Scoping matters because ids are looked up in a single process-wide registry:
 * without the project check, a prompt in one project could reference a file
 * uploaded to another, pulling its path (and, for images, its content) into the
 * wrong conversation. Consuming them stops an id being replayed into an
 * unbounded number of later prompts.
 */
export function takeAttachments(projectId: string, ids: string[]): Attachment[] {
  const out: Attachment[] = []
  for (const id of ids) {
    const found = registry.get(id)
    if (!found || found.projectId !== projectId) continue
    registry.delete(id)
    created.delete(id)
    out.push(found)
  }
  return out
}

/**
 * Keep a project's upload directory under the configured budget.
 *
 * Files are kept after sending (so they can be read again), which means without a
 * ceiling an authenticated client can fill the disk one 20 MB upload at a time.
 * Oldest-first deletion keeps recent context available.
 */
async function enforceQuota(project: Project, incoming: number): Promise<void> {
  const dir = uploadDir(project)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return // no directory yet, nothing to prune
  }

  const stats: { file: string; size: number; mtime: number }[] = []
  for (const entry of entries) {
    const file = path.join(dir, entry)
    try {
      const info = await stat(file)
      if (info.isFile()) stats.push({ file, size: info.size, mtime: info.mtimeMs })
    } catch {
      // vanished underneath us; ignore
    }
  }

  let total = stats.reduce((sum, s) => sum + s.size, 0) + incoming
  if (total <= config.uploadQuotaBytes) return

  stats.sort((a, b) => a.mtime - b.mtime)
  for (const candidate of stats) {
    if (total <= config.uploadQuotaBytes) break
    try {
      await unlink(candidate.file)
      total -= candidate.size
    } catch {
      // leave it; the next upload will try again
    }
  }

  if (total > config.uploadQuotaBytes) {
    throw new Error('Upload directory is over its size budget and could not be pruned.')
  }
}

/**
 * Turn attachments into message content.
 *
 * Images become real `image` blocks so Claude actually sees them — verified to
 * work over the SDK's stream-json input. Everything else is referenced by
 * absolute path and read with the ordinary Read tool, which already handles
 * PDFs, notebooks and text.
 */
export async function buildContent(
  text: string,
  attachments: Attachment[],
): Promise<unknown[] | string> {
  if (attachments.length === 0) return text

  const blocks: unknown[] = []
  const notes: string[] = []

  for (const attachment of attachments) {
    if (attachment.isImage) {
      try {
        const data = await readFile(attachment.path)
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: attachment.mime, data: data.toString('base64') },
        })
        notes.push(`- image: ${attachment.name} (also saved at ${attachment.path})`)
        continue
      } catch {
        notes.push(`- image: ${attachment.name} — could not be read back from ${attachment.path}`)
        continue
      }
    }
    notes.push(`- file: ${attachment.path}`)
  }

  const preamble = [
    text.trim(),
    '',
    'Attached from my phone:',
    ...notes,
  ]
    .join('\n')
    .trim()

  blocks.push({ type: 'text', text: preamble })
  return blocks
}
