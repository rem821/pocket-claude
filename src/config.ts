import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * Minimal .env loader.
 *
 * Node's own --env-file would do, but the systemd unit uses EnvironmentFile= and
 * `npm run dev` should behave identically without extra flags, so the file is
 * read here when a variable isn't already set in the environment.
 */
function loadEnvFile(file: string): void {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (process.env[key] !== undefined) continue
    process.env[key] = trimmed.slice(eq + 1).trim()
  }
}

loadEnvFile(path.resolve(process.cwd(), '.env'))

const home = homedir()

function required(name: string, hint: string): string {
  const value = process.env[name]
  if (!value || value === 'change-me') {
    throw new Error(`${name} is not set. ${hint}`)
  }
  return value
}

/** First executable of that name on PATH, or null. */
function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

/**
 * Locate the `claude` binary.
 *
 * Pinning an absolute path avoids surprises when a shell has a different PATH
 * than the service, but the path differs per machine and per install method, so
 * it is discovered rather than hardcoded.
 */
function resolveClaudeBin(): string {
  const explicit = process.env.CLAUDE_BIN
  if (explicit) return explicit

  const candidates = [
    onPath('claude'),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // keep looking
    }
  }
  throw new Error(
    'Could not find the `claude` binary. Install Claude Code, or set CLAUDE_BIN in .env.',
  )
}

/**
 * Work out which address to bind.
 *
 * `HOST=auto` asks Tailscale for this machine's tailnet address, which keeps the
 * server off the LAN interface entirely without anyone having to hardcode an IP
 * that differs on every machine. Falls back to loopback if Tailscale isn't there.
 */
function resolveHost(): string {
  const configured = process.env.HOST
  if (configured && configured !== 'auto') return configured

  if (configured === 'auto') {
    try {
      const out = execFileSync('tailscale', ['ip', '-4'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const ip = out.split('\n')[0]?.trim()
      if (ip) return ip
    } catch {
      console.warn(
        'HOST=auto but the Tailscale address could not be read; binding 127.0.0.1 instead.',
      )
    }
  }
  return '127.0.0.1'
}

function resolveProjectsRoot(): string {
  const configured = process.env.PROJECTS_ROOT
  const root = path.resolve(configured ?? path.join(home, 'projects'))
  try {
    if (!statSync(root).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error(
      `PROJECTS_ROOT (${root}) does not exist or is not a directory. Set it in .env to the folder that holds your projects.`,
    )
  }
  return root
}

export const config = {
  token: required(
    'POCKET_TOKEN',
    'Copy .env.example to .env and set it (generate one with: openssl rand -hex 24).',
  ),
  host: resolveHost(),
  port: Number(process.env.PORT ?? 7420),
  projectsRoot: resolveProjectsRoot(),
  claudeHome: process.env.CLAUDE_HOME ?? path.join(home, '.claude'),
  claudeBin: resolveClaudeBin(),
  /** Also list projects with Claude history that live outside PROJECTS_ROOT. */
  includeExternalHistory: /^(1|true|yes)$/i.test(process.env.INCLUDE_EXTERNAL_HISTORY ?? ''),
} as const

/** One line at startup so a misconfigured install is obvious immediately. */
export function describeConfig(): string {
  return [
    `projects: ${config.projectsRoot}`,
    `claude:   ${config.claudeBin}`,
    `history:  ${claudeProjectsDir}`,
    `external history: ${config.includeExternalHistory ? 'included' : 'excluded'}`,
  ].join('\n  ')
}

/** Directory Claude Code writes per-project transcripts into. */
export const claudeProjectsDir = path.join(config.claudeHome, 'projects')

export const COOKIE_NAME = 'pc_token'
