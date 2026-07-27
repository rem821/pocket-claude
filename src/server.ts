import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { WebSocketServer, type WebSocket } from 'ws'

import {
  closeRunner,
  getRunner,
  isPermissionMode,
  openRunner,
  shutdownRunners,
  type OutEvent,
} from './agent.js'
import { COOKIE_NAME, config, describeConfig } from './config.js'
import { originAllowed, SECURITY_HEADERS } from './security.js'
import {
  BadProjectName,
  createProject,
  getProject,
  invalidateProjectCache,
  listProjects,
} from './projects.js'
import { listSessions } from './sessions.js'
import { renderTranscript, transcriptPath } from './transcript.js'
import { buildContent, MAX_UPLOAD_BYTES, saveUpload, takeAttachments } from './uploads.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.resolve(here, '..', 'public')

/**
 * Static assets are served from an explicit allowlist rather than a directory
 * handler: there are only four of them, and a filename map has no path
 * traversal surface at all.
 */
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json' },
}

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  // Default is 1 MB, which no phone photo fits inside.
  bodyLimit: MAX_UPLOAD_BYTES + 1024 * 1024,
})

/**
 * Uploads arrive as a raw body with the real type in `x-mime`.
 *
 * One parser for one declared content type is easier to reason about than a
 * wildcard that has to avoid stealing JSON requests.
 */
app.addContentTypeParser(
  'application/octet-stream',
  { parseAs: 'buffer' },
  (_request, body, done) => {
    done(null, body)
  },
)

app.addHook('onRequest', async (request, reply) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    reply.header(name, value)
  }
  // Cookie auth plus a state-changing method is the classic CSRF shape.
  // SameSite=Lax already covers it; this is the belt to that braces.
  if (request.method !== 'GET' && request.method !== 'HEAD' && !originAllowed(request.headers)) {
    app.log.warn(
      { origin: request.headers.origin, url: request.url },
      'rejected request from disallowed origin',
    )
    await reply.code(403).send({ error: 'origin not allowed' })
  }
})

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

function isAuthed(cookieHeader: string | undefined): boolean {
  const token = readCookie(cookieHeader, COOKIE_NAME)
  return token !== null && constantTimeEqual(token, config.token)
}

function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isAuthed(request.headers.cookie)) return true
  reply.code(401).send({ error: 'unauthorized' })
  return false
}

// ---------------------------------------------------------------- static + auth

app.get('/*', async (request, reply) => {
  const asset = STATIC_FILES[request.url.split('?')[0] ?? '']
  if (!asset) {
    reply.code(404).send({ error: 'not found' })
    return
  }
  const body = await readFile(path.join(publicDir, asset.file), 'utf8')
  reply
    .header('content-type', asset.type)
    .header('cache-control', 'no-cache')
    .send(body)
})

app.post<{ Body: { token?: string } }>('/api/login', async (request, reply) => {
  const supplied = request.body?.token ?? ''
  if (!supplied || !constantTimeEqual(supplied, config.token)) {
    // Deliberately slow to make guessing over the tailnet unattractive.
    await new Promise((r) => setTimeout(r, 750))
    reply.code(401).send({ error: 'bad token' })
    return
  }
  const flags = [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=31536000',
    ...(config.cookieSecure ? ['Secure'] : []),
  ].join('; ')
  reply
    .header('set-cookie', `${COOKIE_NAME}=${encodeURIComponent(config.token)}; ${flags}`)
    .send({ ok: true })
})

app.get('/api/me', async (request, reply) => {
  reply.send({ authed: isAuthed(request.headers.cookie) })
})

// -------------------------------------------------------------------- projects

app.get('/api/projects', async (request, reply) => {
  if (!requireAuth(request, reply)) return
  if (request.headers['x-refresh'] === '1') invalidateProjectCache()
  const projects = await listProjects()
  reply.send(
    projects.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
      sessionCount: p.sessionCount,
      lastActivity: p.lastActivity,
      running: getRunner(p) !== undefined,
    })),
  )
})

app.post<{ Body: { name?: string } }>('/api/projects', async (request, reply) => {
  if (!requireAuth(request, reply)) return
  const name = typeof request.body?.name === 'string' ? request.body.name : ''
  try {
    const project = await createProject(name)
    app.log.info({ path: project.path }, 'created project folder')
    reply.code(201).send({
      id: project.id,
      name: project.name,
      path: project.path,
      sessionCount: 0,
      lastActivity: null,
      running: false,
    })
  } catch (err) {
    if (err instanceof BadProjectName) {
      reply.code(400).send({ error: err.message })
      return
    }
    app.log.error({ err }, 'creating project folder failed')
    reply.code(500).send({ error: 'Could not create that folder.' })
  }
})

app.get<{ Params: { id: string } }>('/api/projects/:id/sessions', async (request, reply) => {
  if (!requireAuth(request, reply)) return
  const project = await getProject(request.params.id)
  if (!project) {
    reply.code(404).send({ error: 'unknown project' })
    return
  }
  const sessions = project.historyDir ? await listSessions(project.historyDir) : []
  const runner = getRunner(project)
  reply.send({
    project: { id: project.id, name: project.name, path: project.path },
    live: runner ? { sessionId: runner.sessionId, busy: runner.busy } : null,
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      title: s.title,
      preview: s.preview,
      lastActivity: s.lastActivity,
      entryCount: s.entryCount,
      model: s.model,
    })),
  })
})

app.get<{
  Params: { id: string; sessionId: string }
  Querystring: { before?: string }
}>('/api/projects/:id/sessions/:sessionId/transcript', async (request, reply) => {
  if (!requireAuth(request, reply)) return
  const project = await getProject(request.params.id)
  if (!project?.historyDir) {
    reply.code(404).send({ error: 'unknown project' })
    return
  }
  const file = transcriptPath(project.historyDir, request.params.sessionId)
  if (!file) {
    reply.code(400).send({ error: 'bad session id' })
    return
  }
  const offsetFromEnd = Number(request.query.before ?? 0)
  try {
    const page = await renderTranscript(file, {
      limit: 200,
      offsetFromEnd: Number.isFinite(offsetFromEnd) ? Math.max(0, offsetFromEnd) : 0,
    })
    reply.send(page)
  } catch {
    reply.code(404).send({ error: 'transcript not found' })
  }
})

app.post<{ Params: { id: string }; Body: Buffer }>(
  '/api/projects/:id/attachments',
  async (request, reply) => {
    if (!requireAuth(request, reply)) return
    const project = await getProject(request.params.id)
    if (!project) {
      reply.code(404).send({ error: 'unknown project' })
      return
    }
    const body = request.body
    if (!Buffer.isBuffer(body)) {
      reply.code(400).send({ error: 'Send the file as a raw application/octet-stream body.' })
      return
    }
    const name = String(request.headers['x-filename'] ?? 'file')
    const mime = String(request.headers['x-mime'] ?? 'application/octet-stream')
    try {
      const attachment = await saveUpload(project, name, mime, body)
      app.log.info(
        { name: attachment.name, size: attachment.size, mime: attachment.mime },
        'attachment uploaded',
      )
      reply.code(201).send({
        id: attachment.id,
        name: attachment.name,
        mime: attachment.mime,
        size: attachment.size,
        isImage: attachment.isImage,
      })
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : 'Upload failed.' })
    }
  },
)

app.post<{ Params: { id: string } }>('/api/projects/:id/close', async (request, reply) => {
  if (!requireAuth(request, reply)) return
  const project = await getProject(request.params.id)
  if (!project) {
    reply.code(404).send({ error: 'unknown project' })
    return
  }
  await closeRunner(project)
  reply.send({ ok: true })
})

// ------------------------------------------------------------------- websocket

const wss = new WebSocketServer({
  noServer: true,
  // Prompts are text; attachments go over HTTP. `ws` defaults to 100 MiB, which
  // lets one authenticated client push the process into swap.
  maxPayload: 1024 * 1024,
})

interface ClientMessage {
  t?: string
  text?: string
  id?: string
  decision?: string
  answers?: unknown[]
  mode?: string
  model?: string
  attachments?: unknown[]
}

async function handleSocket(socket: WebSocket, url: URL): Promise<void> {
  const projectId = url.searchParams.get('project')
  const requestedSession = url.searchParams.get('session')

  const send = (event: OutEvent): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event))
  }

  const project = projectId ? await getProject(projectId) : null
  if (!project) {
    send({ t: 'error', message: 'Unknown project.' })
    socket.close(1008, 'unknown project')
    return
  }

  const existing = getRunner(project)
  const wanted = requestedSession && requestedSession !== 'new' ? requestedSession : null

  if (existing && wanted && existing.sessionId && existing.sessionId !== wanted) {
    // The invariant worth protecting is only that two claude processes never
    // append to one project at the same time. A runner that is merely *parked*
    // on another session is not a conflict — hand it over instead of refusing,
    // which previously made a second conversation in the same project
    // permanently unopenable.
    if (existing.busy || existing.pendingCount > 0) {
      send({
        t: 'error',
        message: `${project.name} is busy with another conversation. Wait for it to finish, or open that one instead.`,
      })
      // 4001 = deliberate refusal. The client must not treat this as a dropped
      // connection and retry forever.
      socket.close(4001, 'busy')
      return
    }
    app.log.info(
      { project: project.name, from: existing.sessionId, to: wanted },
      'handing idle runner over to another session',
    )
    await closeRunner(project)
  }

  let runner
  try {
    runner = openRunner(project, wanted ?? getRunner(project)?.sessionId ?? null)
  } catch (err) {
    send({ t: 'error', message: err instanceof Error ? err.message : 'Could not open that.' })
    socket.close(4001, 'at capacity')
    return
  }
  // attach() sends the session id, current busy state, and any permission
  // request still waiting on an answer.
  const detach = runner.attach(send)

  socket.on('message', (raw) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage
    } catch {
      return
    }
    switch (msg.t) {
      case 'prompt': {
        const text = (msg.text ?? '').trim()
        const ids = Array.isArray(msg.attachments)
          ? msg.attachments.filter((a): a is string => typeof a === 'string')
          : []
        if (!text && ids.length === 0) return
        const attachments = takeAttachments(project.id, ids)
        // Images are read off disk and inlined as base64 here, so this is async.
        void buildContent(text, attachments)
          .then((content) => {
            runner.send(content)
          })
          .catch((err: unknown) => {
            send({ t: 'error', message: err instanceof Error ? err.message : String(err) })
          })
        break
      }
      case 'permission': {
        if (!msg.id) return
        // Do NOT coerce an unrecognised value to 'deny'. A dropped or garbled
        // field would then be reported to Claude as a deliberate refusal by the
        // user, which is both wrong and impossible to debug. Ignoring it leaves
        // the card live so it can simply be tapped again.
        if (msg.decision !== 'allow' && msg.decision !== 'deny') {
          app.log.warn(
            { permId: msg.id, decision: msg.decision, project: project.name },
            'discarding permission message with unrecognised decision',
          )
          send({ t: 'notice', message: 'That tap did not come through — try again.' })
          return
        }
        app.log.info(
          { permId: msg.id, decision: msg.decision, project: project.name },
          'permission decision from phone',
        )
        if (!runner.decide(msg.id, msg.decision)) {
          send({ t: 'notice', message: 'That permission request already expired.' })
        }
        break
      }

      case 'answer': {
        if (!msg.id || !Array.isArray(msg.answers)) return
        const answers = msg.answers
          .filter((a): a is { question?: unknown; selected?: unknown } => !!a && typeof a === 'object')
          .map((a) => ({
            question: typeof a.question === 'string' ? a.question : '',
            selected: Array.isArray(a.selected)
              ? a.selected.filter((s): s is string => typeof s === 'string')
              : [],
          }))
        app.log.info(
          { permId: msg.id, answers, project: project.name },
          'question answered from phone',
        )
        if (!runner.answer(msg.id, answers)) {
          send({ t: 'notice', message: 'That question already expired.' })
        }
        break
      }
      case 'interrupt':
        void runner.interrupt()
        break

      case 'setMode': {
        if (!isPermissionMode(msg.mode)) {
          send({ t: 'notice', message: 'Unknown mode.' })
          return
        }
        const mode = msg.mode
        void runner.setMode(mode).catch((err: unknown) => {
          send({
            t: 'error',
            message: `Could not switch mode: ${err instanceof Error ? err.message : String(err)}`,
          })
        })
        app.log.info({ mode, project: project.name }, 'permission mode changed from phone')
        break
      }

      case 'setModel': {
        const model = typeof msg.model === 'string' && msg.model ? msg.model : null
        void runner.setModel(model).catch((err: unknown) => {
          send({
            t: 'error',
            message: `Could not switch model: ${err instanceof Error ? err.message : String(err)}`,
          })
        })
        app.log.info({ model, project: project.name }, 'model changed from phone')
        break
      }

      case 'commands': {
        // Needs a live run, so this starts the subprocess if it isn't up yet.
        void runner
          .commands()
          .then((commands) => send({ t: 'commands', commands }))
          .catch(() => send({ t: 'commands', commands: [] }))
        break
      }

      case 'models': {
        void runner
          .models()
          .then((models) => send({ t: 'models', models, current: runner.liveModel }))
          .catch(() => send({ t: 'models', models: [], current: runner.liveModel }))
        break
      }

      default:
        break
    }
  })

  socket.on('close', () => {
    detach()
  })
}

app.server.on('upgrade', (request, rawSocket, head) => {
  const destroy = (code: string): void => {
    rawSocket.write(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`)
    rawSocket.destroy()
  }

  if (!isAuthed(request.headers.cookie)) {
    destroy('401 Unauthorized')
    return
  }

  // A foreign page must not be able to open this socket even if it somehow has
  // the cookie attached — the socket can send prompts, and in bypassPermissions
  // mode those run without asking.
  if (!originAllowed(request.headers)) {
    app.log.warn({ origin: request.headers.origin }, 'rejected websocket from disallowed origin')
    destroy('403 Forbidden')
    return
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  if (url.pathname !== '/ws') {
    destroy('404 Not Found')
    return
  }

  wss.handleUpgrade(request, rawSocket, head, (socket) => {
    void handleSocket(socket, url).catch((err: unknown) => {
      app.log.error({ err }, 'websocket handler failed')
      socket.close(1011, 'internal error')
    })
  })
})

// ----------------------------------------------------------------------- start

async function main(): Promise<void> {
  await app.listen({ host: config.host, port: config.port })
  app.log.info(
    `pocket-claude on http://${config.host}:${config.port}\n  ${describeConfig()}`,
  )
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      app.log.info(`${signal} received, shutting down`)
      await shutdownRunners()
      await app.close()
      process.exit(0)
    })()
  })
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
