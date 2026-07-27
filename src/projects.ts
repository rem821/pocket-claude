import { mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { claudeProjectsDir, config } from './config.js'
import { readTranscriptCwd, transcriptFiles } from './sessions.js'

export interface Project {
  /** base64url of the absolute path — opaque to the client, never a raw path. */
  id: string
  name: string
  path: string
  /** Directory name under ~/.claude/projects, if this project has history. */
  historyDir: string | null
  sessionCount: number
  lastActivity: number | null
}

export function encodeId(absPath: string): string {
  return Buffer.from(absPath, 'utf8').toString('base64url')
}

function decodeId(id: string): string | null {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8')
    return decoded || null
  } catch {
    return null
  }
}

interface HistoryInfo {
  dir: string
  sessionCount: number
  lastActivity: number
}

/**
 * Map absolute project path -> Claude history directory.
 *
 * Built by reading the `cwd` out of each transcript rather than by decoding the
 * directory name, which is lossy (see readTranscriptCwd).
 */
async function scanHistory(): Promise<Map<string, HistoryInfo>> {
  const byPath = new Map<string, HistoryInfo>()
  let dirs
  try {
    dirs = await readdir(claudeProjectsDir, { withFileTypes: true })
  } catch {
    return byPath
  }

  await Promise.all(
    dirs
      .filter((d) => d.isDirectory())
      .map(async (d) => {
        const dir = path.join(claudeProjectsDir, d.name)
        const files = await transcriptFiles(dir)
        if (files.length === 0) return

        const stats = await Promise.all(
          files.map(async (f) => {
            try {
              return { file: f, mtimeMs: (await stat(f)).mtimeMs }
            } catch {
              return null
            }
          }),
        )
        const usable = stats.filter((s): s is { file: string; mtimeMs: number } => s !== null)
        if (usable.length === 0) return

        usable.sort((a, b) => b.mtimeMs - a.mtimeMs)
        const newest = usable[0]!

        // Only the newest transcript is opened; every transcript in a directory
        // shares the same cwd, so one read identifies the whole directory.
        const cwd = await readTranscriptCwd(newest.file).catch(() => null)
        if (!cwd) return

        byPath.set(cwd, {
          dir: d.name,
          sessionCount: usable.length,
          lastActivity: newest.mtimeMs,
        })
      }),
  )

  return byPath
}

let cache: { at: number; value: Project[] } | null = null
const CACHE_MS = 5_000

export async function listProjects(): Promise<Project[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value

  const [dirEntries, history] = await Promise.all([
    readdir(config.projectsRoot, { withFileTypes: true }).catch(() => []),
    scanHistory(),
  ])

  const projects: Project[] = []
  const seen = new Set<string>()

  for (const entry of dirEntries) {
    // A symlinked project directory is still a project.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('.')) continue
    const abs = path.join(config.projectsRoot, entry.name)
    if (entry.isSymbolicLink()) {
      const isDir = await stat(abs)
        .then((s) => s.isDirectory())
        .catch(() => false)
      if (!isDir) continue
    }
    seen.add(abs)
    const info = history.get(abs)
    projects.push({
      id: encodeId(abs),
      name: entry.name,
      path: abs,
      historyDir: info?.dir ?? null,
      sessionCount: info?.sessionCount ?? 0,
      lastActivity: info?.lastActivity ?? null,
    })
  }

  // Off by default: PROJECTS_ROOT should mean what it says. Turning it on
  // surfaces every directory in ~/.claude/projects, including ones nowhere near
  // the configured root — handy if you have history scattered around, confusing
  // if you expected the root to scope the list.
  if (config.includeExternalHistory) {
    for (const [abs, info] of history) {
      if (seen.has(abs)) continue
      projects.push({
        id: encodeId(abs),
        name: path.basename(abs),
        path: abs,
        historyDir: info.dir,
        sessionCount: info.sessionCount,
        lastActivity: info.lastActivity,
      })
    }
  }

  projects.sort((a, b) => {
    if (a.lastActivity && b.lastActivity) return b.lastActivity - a.lastActivity
    if (a.lastActivity) return -1
    if (b.lastActivity) return 1
    return a.name.localeCompare(b.name, 'cs')
  })

  cache = { at: Date.now(), value: projects }
  return projects
}

/**
 * Resolve a client-supplied project id back to a real project.
 *
 * Returns null unless the decoded path is one we actually enumerated, so a
 * hand-crafted id cannot point the agent at an arbitrary directory.
 */
export async function getProject(id: string): Promise<Project | null> {
  const abs = decodeId(id)
  if (!abs || !path.isAbsolute(abs)) return null
  const projects = await listProjects()
  return projects.find((p) => p.path === abs) ?? null
}

export function invalidateProjectCache(): void {
  cache = null
}

export class BadProjectName extends Error {}

/**
 * Validate a folder name supplied from the phone.
 *
 * Rejects rather than sanitises: silently rewriting a name would create a folder
 * the user didn't ask for. Unicode letters are fine — what matters is that the
 * name is a single path segment that cannot escape PROJECTS_ROOT.
 */
function validateName(raw: string): string {
  const name = raw.normalize('NFC')

  if (!name) throw new BadProjectName('Give the project a name.')
  if (name !== name.trim()) throw new BadProjectName('No leading or trailing spaces.')
  if (name.length > 64) throw new BadProjectName('Keep the name under 64 characters.')
  if (name === '.' || name === '..') throw new BadProjectName('That name is not allowed.')
  if (name.startsWith('.')) throw new BadProjectName('Names cannot start with a dot.')
  // A leading dash turns the folder into an accidental flag in half the shell
  // commands that might later run on it.
  if (name.startsWith('-')) throw new BadProjectName('Names cannot start with a dash.')
  if (name.includes('/') || name.includes('\\')) {
    throw new BadProjectName('Use a single name, not a path.')
  }
  if (name.endsWith('.')) throw new BadProjectName('Names cannot end with a dot.')
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) {
      throw new BadProjectName('That name contains control characters.')
    }
  }

  return name
}

/**
 * Create a new project folder directly under PROJECTS_ROOT.
 *
 * Belt and braces: the name is validated as a single segment above, and the
 * resolved path is then checked to be a direct child of the root, so no amount
 * of clever input lands the folder somewhere else.
 */
export async function createProject(rawName: string): Promise<Project> {
  const name = validateName(rawName)
  const root = path.resolve(config.projectsRoot)
  const target = path.resolve(root, name)

  if (path.dirname(target) !== root) {
    throw new BadProjectName('That name would land outside the projects folder.')
  }

  const existing = await stat(target).catch(() => null)
  if (existing) {
    throw new BadProjectName(
      existing.isDirectory()
        ? 'A project with that name already exists.'
        : 'A file with that name already exists.',
    )
  }

  // Not recursive: the root must already exist, and one new folder is the entire
  // intent — recursive would quietly accept a nested path.
  await mkdir(target, { recursive: false, mode: 0o755 })
  invalidateProjectCache()

  return {
    id: encodeId(target),
    name,
    path: target,
    historyDir: null,
    sessionCount: 0,
    lastActivity: null,
  }
}
