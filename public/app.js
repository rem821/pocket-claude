// pocket-claude frontend. No framework, no build step.

const $ = (id) => document.getElementById(id)

const state = {
  view: 'login',
  projects: [],
  project: null,
  sessionId: null,
  ws: null,
  busy: false,
  /** Element currently receiving streamed token deltas. */
  streamEl: null,
  earliestOffset: 0,
  totalMessages: 0,
  reconnectTimer: null,
  /** True between pressing Stop and the turn actually ending. */
  interrupting: false,
  connected: false,
  /** null until the server says — the CLI picks the start mode from settings. */
  mode: null,
  model: null,
  /** Effort the CLI will send next, as reported by the server; null = not known yet. */
  effort: null,
  /**
   * Tool calls waiting on a tap, keyed by id. This map — not whatever cards
   * happen to be in the DOM — is the source of truth. The server re-sends every
   * pending request when a socket opens, so it is cleared on each open and
   * rebuilt from that replay; anything the server no longer has simply never
   * comes back, which is what keeps dead cards off the screen.
   */
  pending: new Map(),
  /** Bumped per transcript load so a slow, superseded load never renders. */
  loadGen: 0,
  /** Live background tasks (subagents, background shells) for the status line. */
  bgTasks: [],
  busySince: null,
  tickTimer: null,
  currentTool: null,
  commands: null,
  /** Timestamp of the last frame received on the socket; drives the watchdog. */
  lastEventAt: null,
  /** Files staged for the next prompt. */
  attachments: [],
}

// ------------------------------------------------------------------ utilities

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Small markdown subset: fenced code, inline code, bold, italic, links,
 * headings, and lists. Input is escaped before any markup is produced, so
 * transcript content can never inject HTML.
 */
function markdown(src) {
  const fences = []
  let text = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, body) => {
    fences.push(
      `<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${escapeHtml(body.replace(/\n$/, ''))}</code></pre>`,
    )
    return `\u0000FENCE${fences.length - 1}\u0000`
  })

  text = escapeHtml(text)

  const inline = (s) =>
    s
      .replace(/`([^`\n]+)`/g, (_m, code) => `<code>${code}</code>`)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(
        /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
      )

  const out = []
  let list = null

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`)
      list = null
    }
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd()

    if (/^\u0000FENCE\d+\u0000$/.test(line.trim())) {
      closeList()
      out.push(line.trim())
      continue
    }
    if (!line.trim()) {
      closeList()
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = Math.min(heading[1].length + 2, 6)
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      if (list !== 'ul') {
        closeList()
        out.push('<ul>')
        list = 'ul'
      }
      out.push(`<li>${inline(bullet[1])}</li>`)
      continue
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (numbered) {
      if (list !== 'ol') {
        closeList()
        out.push('<ol>')
        list = 'ol'
      }
      out.push(`<li>${inline(numbered[1])}</li>`)
      continue
    }

    closeList()
    out.push(`<p>${inline(line)}</p>`)
  }
  closeList()

  return out.join('').replace(/\u0000FENCE(\d+)\u0000/g, (_m, i) => fences[Number(i)])
}

function relTime(ms) {
  if (!ms) return ''
  const diff = Date.now() - ms
  const min = Math.round(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hours = Math.round(min / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ms).toLocaleDateString()
}

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...options })
  if (res.status === 401) {
    show('login')
    throw new Error('unauthorized')
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

function show(view) {
  state.view = view
  for (const name of ['login', 'projects', 'sessions', 'chat']) {
    $(`view-${name}`).hidden = name !== view
  }
  saveLocation()
}

// ------------------------------------------------------------------- projects

function renderProjects() {
  const filter = $('project-search').value.trim().toLowerCase()
  const items = filter
    ? state.projects.filter((p) => p.name.toLowerCase().includes(filter))
    : state.projects

  const list = $('project-list')
  list.textContent = ''
  for (const project of items) {
    const li = document.createElement('li')
    const button = document.createElement('button')
    button.className = 'row'

    const main = document.createElement('span')
    main.className = 'row-main'
    const title = document.createElement('span')
    title.className = 'row-title'
    title.textContent = project.name
    main.append(title)

    if (project.sessionCount > 0) {
      const sub = document.createElement('span')
      sub.className = 'row-sub'
      sub.textContent = `${project.sessionCount} conversation${project.sessionCount === 1 ? '' : 's'} · ${relTime(project.lastActivity)}`
      main.append(sub)
    }
    button.append(main)

    if (project.running) {
      const dot = document.createElement('span')
      dot.className = 'dot'
      dot.title = 'A conversation is open'
      button.append(dot)
    }
    if (project.sessionCount > 0) {
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = project.sessionCount
      button.append(badge)
    }

    button.addEventListener('click', () => openProject(project))
    li.append(button)
    list.append(li)
  }
  $('project-empty').hidden = items.length > 0
}

async function loadProjects(refresh = false) {
  state.projects = await api('/api/projects', refresh ? { headers: { 'x-refresh': '1' } } : {})
  renderProjects()
}

// ------------------------------------------------------------------- sessions

async function openProject(project) {
  state.project = project
  $('sessions-title').textContent = project.name
  $('sessions-path').textContent = project.path
  show('sessions')

  const data = await api(`/api/projects/${project.id}/sessions`)
  const list = $('session-list')
  list.textContent = ''

  for (const session of data.sessions) {
    const li = document.createElement('li')
    const button = document.createElement('button')
    button.className = 'row'

    const main = document.createElement('span')
    main.className = 'row-main'
    const title = document.createElement('span')
    title.className = 'row-title'
    title.textContent = session.title
    const sub = document.createElement('span')
    sub.className = 'row-sub'
    sub.textContent = `${relTime(session.lastActivity)} · ${session.entryCount} entries`
    main.append(title, sub)
    button.append(main)

    if (data.live && data.live.sessionId === session.sessionId) {
      const dot = document.createElement('span')
      dot.className = 'dot'
      button.append(dot)
    }

    button.addEventListener('click', () =>
      openChat(session.sessionId, session.title, session.model ?? null),
    )
    li.append(button)
    list.append(li)
  }
  $('sessions-empty').hidden = data.sessions.length > 0
}

// ----------------------------------------------------------------------- chat

function messagesEl() {
  return $('messages')
}

function scrollToBottom(force = false) {
  const scroll = $('chat-scroll')
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 160
  if (force || nearBottom) scroll.scrollTop = scroll.scrollHeight
}

function blockToNode(block) {
  if (block.kind === 'text') {
    const div = document.createElement('div')
    div.innerHTML = markdown(block.text)
    return div
  }
  if (block.kind === 'image') {
    // The base64 stays server-side; this is just a marker that one was sent.
    const span = document.createElement('span')
    span.className = 'img-block'
    span.textContent = `🖼 image sent (${block.mime})`
    return span
  }
  if (block.kind === 'note') {
    // Harness events the CLI shows as a status line, not as something typed:
    // background task results, compaction, slash-command output.
    const details = document.createElement('details')
    details.className = block.isError ? 'chip note err' : 'chip note'
    const summary = document.createElement('summary')
    summary.append(span('chip-name', block.label), span('chip-sum', block.summary || ''))
    details.append(summary)
    if (block.detail) details.append(pre(block.detail))
    return details
  }
  // Tool calls, results and thinking are activity, rendered by addActivity().
  return document.createComment(block.kind)
}

function span(className, text) {
  const el = document.createElement('span')
  el.className = className
  el.textContent = text
  return el
}

function pre(text, className = '') {
  const el = document.createElement('pre')
  if (className) el.className = className
  el.textContent = text
  return el
}

// ------------------------------------------------------------ activity groups
//
// The CLI doesn't print each tool call and each result as its own message. A
// run of activity between two pieces of text collapses into one line — "Read 3
// files, ran 2 commands" — that expands on demand. Same here:
//
//   - a call and its result share one row (✓ / ✕ / … for still running);
//   - consecutive rows share one group, with thinking folded in;
//   - text, your own messages and notes end the run;
//   - a group only collapses behind a summary once it holds two or more tool
//     calls — "ran 1 command" would hide the one thing worth reading.

const ACTIVITY_KINDS = new Set(['tool_use', 'tool_result', 'thinking'])

/** How a tool is counted in a group summary. `distinct` counts unique targets. */
function toolCategory(name) {
  if (name.startsWith('mcp__')) {
    const server = name.split('__')[1] || 'MCP'
    return { key: `mcp:${server}`, verb: 'made', noun: `${server} call`, distinct: false }
  }
  switch (name) {
    case 'Read':
      return { key: 'read', verb: 'read', noun: 'file', distinct: true }
    case 'Grep':
    case 'Glob':
      return { key: 'search', verb: 'searched', noun: 'pattern', distinct: true }
    case 'Bash':
    case 'PowerShell':
      return { key: 'run', verb: 'ran', noun: 'command', distinct: false }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { key: 'edit', verb: 'edited', noun: 'file', distinct: true }
    case 'Write':
      return { key: 'write', verb: 'wrote', noun: 'file', distinct: true }
    case 'WebFetch':
      return { key: 'fetch', verb: 'fetched', noun: 'page', distinct: true }
    case 'WebSearch':
      return { key: 'web', verb: 'ran', noun: 'web search', distinct: false }
    case 'Agent':
    case 'Task':
      return { key: 'agent', verb: 'started', noun: 'agent', distinct: false }
    default:
      return { key: `tool:${name}`, verb: 'used', noun: null, name, distinct: false }
  }
}

/** `mcp__chrome-devtools__click` reads better as `chrome-devtools · click`. */
function toolLabel(name) {
  if (!name.startsWith('mcp__')) return name
  const [, server, ...rest] = name.split('__')
  return `${server} · ${rest.join('__')}`
}

function toolItems(wrap) {
  return wrap.querySelectorAll(':scope .group-items > .item[data-kind="tool"]')
}

function summarizeGroup(wrap) {
  const phrases = new Map()
  let failed = 0
  let running = 0
  for (const item of toolItems(wrap)) {
    const cat = toolCategory(item.dataset.tool)
    let entry = phrases.get(cat.key)
    if (!entry) {
      entry = { cat, targets: new Set(), count: 0 }
      phrases.set(cat.key, entry)
    }
    entry.count++
    entry.targets.add(item.dataset.target || `#${entry.count}`)
    if (item.dataset.state === 'err') failed++
    if (item.dataset.state === 'running') running++
  }
  const parts = []
  for (const { cat, targets, count } of phrases.values()) {
    const n = cat.distinct ? targets.size : count
    parts.push(
      cat.noun ? `${cat.verb} ${n} ${cat.noun}${n === 1 ? '' : 's'}` : `${cat.verb} ${cat.name}${n > 1 ? ` ×${n}` : ''}`,
    )
  }
  const text = parts.join(', ')
  return { text: text.charAt(0).toUpperCase() + text.slice(1), failed, running }
}

function updateGroup(wrap) {
  const tools = toolItems(wrap).length
  // Collapse behind a summary only when there is something to summarise.
  wrap.classList.toggle('flat', tools < 2)
  if (tools < 2) return
  const { text, failed, running } = summarizeGroup(wrap)
  wrap.querySelector('.group-sum').textContent = text
  const stateEl = wrap.querySelector('.group-state')
  // Like the CLI, no call count — only what needs attention.
  stateEl.textContent = running ? '…' : failed ? `${failed} failed` : ''
  stateEl.className = `group-state${failed ? ' bad' : ''}`
}

/** Elements that sit at the bottom without belonging to the conversation flow. */
function isTrailing(el) {
  return el.classList.contains('perm') || el.classList.contains('streaming')
}

/** The group activity should go into: the last one, unless something has ended it. */
function openGroup(container) {
  let last = container.lastElementChild
  let firstTrailing = null
  while (last && isTrailing(last)) {
    firstTrailing = last
    last = last.previousElementSibling
  }
  if (last && last.classList.contains('activity')) return last

  const wrap = document.createElement('div')
  wrap.className = 'msg assistant activity flat'
  const group = document.createElement('div')
  group.className = 'group'
  const head = document.createElement('button')
  head.className = 'group-head'
  head.type = 'button'
  head.append(span('group-sum', ''), span('group-state', ''))
  head.addEventListener('click', () => wrap.classList.toggle('open'))
  const items = document.createElement('div')
  items.className = 'group-items'
  group.append(head, items)
  wrap.append(group)
  // Cards still waiting for a tap stay at the very bottom, where they are seen.
  container.insertBefore(wrap, firstTrailing)
  return wrap
}

/**
 * Paths read the way the CLI prints them: relative to the project, else with
 * the home directory as `~`. Display only — counting uses the full path.
 */
function shortPaths(text) {
  const root = state.project?.path
  let out = text
  if (root) out = out.split(`${root}/`).join('').split(root).join('.')
  return out.replace(/(^|[\s'"=(])\/(?:home|Users)\/[^/\s]+(?=\/|\s|$)/g, '$1~')
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/**
 * A long path loses its end to the ellipsis on a phone — exactly the part
 * that matters. Keep the last few segments instead: `…/pocket-claude/src/agent.ts`.
 */
function shortFile(path) {
  const short = shortPaths(path)
  if (short.length <= 34) return short
  const parts = short.split('/')
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : short
}

function toolRow(name, summaryText, state, title = '') {
  const item = document.createElement('details')
  item.className = 'chip item'
  item.dataset.kind = 'tool'
  item.dataset.tool = name
  item.dataset.target = summaryText
  const summary = document.createElement('summary')
  const label = span('chip-sum', title || (FILE_TOOLS.has(name) ? shortFile(summaryText) : shortPaths(summaryText)))
  if (title) label.classList.add('titled')
  summary.append(span('chip-name', toolLabel(name)), label, span('item-mark', ''))
  item.append(summary)
  setRowState(item, state)
  return item
}

function setRowState(item, state) {
  item.dataset.state = state
  item.classList.toggle('err', state === 'err')
  item.querySelector('.item-mark').textContent = state === 'ok' ? '✓' : state === 'err' ? '✕' : '…'
}

function addResult(item, block) {
  setRowState(item, block.isError ? 'err' : 'ok')
  if (block.summary) item.append(pre(block.summary, 'item-out'))
}

/** Put one activity block into the open group of `container`. */
function addActivity(block, container) {
  const wrap = openGroup(container)
  const items = wrap.querySelector('.group-items')

  if (block.kind === 'thinking') {
    const details = document.createElement('details')
    details.className = 'chip think item'
    details.dataset.kind = 'thinking'
    const summary = document.createElement('summary')
    summary.append(span('chip-name', 'thinking'))
    details.append(summary, pre(block.text))
    items.append(details)
  } else if (block.kind === 'tool_use') {
    const item = toolRow(block.name, block.summary || '', 'running', block.title || '')
    if (block.id) item.dataset.toolId = block.id
    // A shell call's input is just the command (plus the description already
    // shown as the label); show it as typed rather than as JSON.
    const isShell = block.name === 'Bash' || block.name === 'PowerShell'
    if (isShell && block.summary) item.append(pre(`$ ${block.summary}`, 'item-in'))
    else if (block.input) item.append(pre(block.input, 'item-in'))
    items.append(item)
  } else {
    // Pair by id; without one (an older server), the oldest call still
    // waiting is the best guess — results come back in call order.
    const match =
      (block.toolUseId && container.querySelector(`.item[data-tool-id="${CSS.escape(block.toolUseId)}"]`)) ||
      (!block.toolUseId && items.querySelector('.item[data-kind="tool"][data-state="running"]:not([data-tool-id])'))
    if (match) {
      addResult(match, block)
      updateGroup(match.closest('.activity'))
      return
    }
    // A result whose call is on an earlier page, or was never seen.
    const item = toolRow('result', (block.summary || '').split('\n')[0], 'running')
    addResult(item, block)
    items.append(item)
  }
  updateGroup(wrap)
}

/**
 * Render one message. Activity blocks go into the open group; anything else
 * goes into a bubble, which also ends the group. `container` defaults to the
 * live list; loadEarlier() passes a detached one.
 */
function appendMessage(message, container = messagesEl()) {
  let bubble = null
  for (const block of message.blocks) {
    if (ACTIVITY_KINDS.has(block.kind)) {
      bubble = null
      addActivity(block, container)
      continue
    }
    if (!bubble) {
      const wrap = document.createElement('div')
      wrap.className = `msg ${message.role}`
      bubble = document.createElement('div')
      bubble.className = 'bubble'
      wrap.append(bubble)
      container.append(wrap)
    }
    bubble.append(blockToNode(block))
  }
}

/** Same order as the CLI's Shift+Tab cycle. */
const MODE_ORDER = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']

const MODE_LABELS = {
  default: 'Ask',
  acceptEdits: 'Auto-edit',
  plan: 'Plan',
  auto: 'Auto',
  bypassPermissions: 'Bypass',
  dontAsk: "Don't ask",
}

const MODE_HELP = {
  default: 'Ask before running anything that writes or executes.',
  acceptEdits: 'File edits go through automatically; other tools still ask.',
  plan: 'Research and propose only — no edits or commands until you approve a plan.',
  auto: 'A safety classifier approves routine actions and blocks risky ones, like the CLI’s auto mode. You only get asked when it can’t decide.',
  bypassPermissions: 'Never ask, no classifier. Anything Claude decides to do just runs.',
  dontAsk: 'Never ask. Anything not already allowed by your rules is denied.',
}

/**
 * `claude-opus-5[1m]` reads better as `opus-5[1m]` on a phone.
 *
 * The SDK only emits its init message once the first turn starts, so before that
 * there is genuinely no model set and "default" is the accurate label — not a
 * placeholder for something we failed to read.
 */
function shortModel(model) {
  if (!model) return 'default'
  return model.replace(/^claude-/, '')
}

function renderChips() {
  const modeChip = $('chip-mode')
  modeChip.textContent = state.mode ? (MODE_LABELS[state.mode] ?? state.mode) : 'mode…'
  modeChip.classList.toggle(
    'hot',
    state.mode === 'plan' || state.mode === 'acceptEdits' || state.mode === 'auto',
  )
  modeChip.classList.toggle('warn', state.mode === 'bypassPermissions')
  $('chip-model').textContent = shortModel(state.model)
  const effortChip = $('chip-effort')
  effortChip.textContent = state.effort ? `effort: ${state.effort}` : 'effort…'
  effortChip.classList.toggle('hot', state.effort === 'max')
}

/** Human-readable "what is it doing right now", refreshed once a second. */
function renderStatus() {
  const status = $('chat-status')
  const bg = state.bgTasks.length
  const bgText = bg ? ` · ${bg} in background` : ''
  if (!state.busy) {
    status.textContent = (state.connected ? 'ready' : 'disconnected') + bgText
    return
  }
  const secs = state.busySince ? Math.round((Date.now() - state.busySince) / 1000) : 0
  const what = state.currentTool ? `${state.currentTool}` : 'working'
  status.textContent = `${what} · ${secs}s${bgText}`
}

function setBusy(busy) {
  const wasBusy = state.busy
  state.busy = busy
  $('send').hidden = busy
  $('stop').hidden = !busy
  $('spinner').hidden = !busy
  document.body.classList.toggle('working', busy)

  if (busy && !wasBusy) {
    state.busySince = Date.now()
    state.currentTool = null
    clearInterval(state.tickTimer)
    state.tickTimer = setInterval(renderStatus, 1000)
  } else if (!busy) {
    clearInterval(state.tickTimer)
    state.tickTimer = null
    state.busySince = null
    state.currentTool = null
  }
  renderStatus()
}

function notice(text, bad = false) {
  const el = $('composer-notice')
  el.textContent = text
  el.className = bad ? 'notice bad' : 'notice'
  el.hidden = !text
}

function cardsFor(id) {
  return messagesEl().querySelectorAll(`[data-perm-id="${CSS.escape(id)}"]`)
}

/**
 * Put a request card at the bottom of the conversation.
 *
 * Idempotent: any earlier card for the same id is removed first, so however
 * many times a request is replayed (every reconnect replays all of them) there
 * is exactly one card for it. Two copies used to be possible — a tap then
 * resolved the hidden one and the visible one answered "already expired"
 * forever after.
 */
function placeCard(id, card) {
  for (const old of cardsFor(id)) old.remove()
  card.dataset.permId = id
  messagesEl().append(card)
  scrollToBottom(true)
}

function renderPending(event) {
  if (event.t === 'question') questionCard(event)
  else permissionCard(event)
}

/** Lock a card's buttons between a tap and the server's answer to it. */
function lockCard(id, locked) {
  for (const card of cardsFor(id)) {
    if (card.classList.contains('done')) continue
    for (const b of card.querySelectorAll('.perm-actions button')) b.disabled = locked
  }
}

function button(label, onClick, primary = false) {
  const b = document.createElement('button')
  if (primary) b.className = 'primary'
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}

function planText(serializedInput) {
  try {
    const input = JSON.parse(serializedInput)
    return typeof input?.plan === 'string' ? input.plan : null
  } catch {
    return null
  }
}

function permissionCard(event) {
  const card = document.createElement('div')
  card.className = 'perm'
  // ExitPlanMode is the CLI's "ready to code?" prompt, and like the CLI the
  // approval picks the mode the work continues in.
  const isPlan = event.name === 'ExitPlanMode'

  const h3 = document.createElement('h3')
  h3.textContent = isPlan
    ? 'Ready to code? Here is Claude’s plan.'
    : event.title || `Claude wants to use ${event.name}`
  card.append(h3)

  if (event.reason) {
    const why = document.createElement('p')
    why.className = 'muted tiny'
    why.textContent = event.reason
    card.append(why)
  }

  const plan = isPlan ? planText(event.input) : null
  if (plan) {
    const div = document.createElement('div')
    div.className = 'plan'
    div.innerHTML = markdown(plan)
    card.append(div)
  } else {
    if (event.summary) {
      const pre = document.createElement('pre')
      pre.textContent = event.summary
      card.append(pre)
    }
    const details = document.createElement('details')
    details.className = 'chip'
    const summary = document.createElement('summary')
    const name = document.createElement('span')
    name.className = 'chip-name'
    name.textContent = 'full input'
    summary.append(name)
    const pre = document.createElement('pre')
    pre.textContent = event.input
    details.append(summary, pre)
    card.append(details)
  }

  const actions = document.createElement('div')
  actions.className = 'perm-actions'
  if (isPlan) {
    actions.classList.add('stack')
    actions.append(
      button('Yes, and use auto mode', () => decide(event.id, 'allow', 'auto'), true),
      button('Yes, auto-accept edits', () => decide(event.id, 'allow', 'acceptEdits')),
      button('Yes, manually approve edits', () => decide(event.id, 'allow', 'default')),
      button('No, keep planning', () => decide(event.id, 'deny')),
    )
  } else {
    actions.append(
      button('Deny', () => decide(event.id, 'deny')),
      button('Allow', () => decide(event.id, 'allow'), true),
    )
  }
  card.append(actions)
  placeCard(event.id, card)
}

function decide(id, decision, mode) {
  // One tap is enough; locking stops a second tap racing the first. If the
  // answer is lost with a dying socket, the reconnect replay redraws the card
  // unlocked, and the timer covers a server that never answers at all.
  lockCard(id, true)
  if (!send({ t: 'permission', id, decision, ...(mode ? { mode } : {}) })) {
    lockCard(id, false)
    return
  }
  setTimeout(() => lockCard(id, false), 8000)
}

/** Card for the AskUserQuestion tool. Same `.perm` shell as a permission card. */
function questionCard(event) {
  const card = document.createElement('div')
  card.className = 'perm'
  card.dataset.kind = 'question'

  // question text -> Set of chosen labels
  const picked = event.questions.map(() => new Set())

  event.questions.forEach((q, qi) => {
    const h3 = document.createElement('h3')
    h3.textContent = q.question
    card.append(h3)

    for (const option of q.options) {
      const button = document.createElement('button')
      button.className = 'opt'
      const label = document.createElement('span')
      label.className = 'opt-label'
      label.textContent = option.label
      button.append(label)
      if (option.description) {
        const desc = document.createElement('span')
        desc.className = 'opt-desc'
        desc.textContent = option.description
        button.append(desc)
      }
      button.addEventListener('click', () => {
        if (q.multiSelect) {
          if (picked[qi].has(option.label)) {
            picked[qi].delete(option.label)
            button.classList.remove('on')
          } else {
            picked[qi].add(option.label)
            button.classList.add('on')
          }
        } else {
          picked[qi].clear()
          picked[qi].add(option.label)
          for (const sibling of card.querySelectorAll(`[data-q="${qi}"]`)) {
            sibling.classList.remove('on')
          }
          button.classList.add('on')
        }
      })
      button.dataset.q = String(qi)
      card.append(button)
    }
  })

  const actions = document.createElement('div')
  actions.className = 'perm-actions'
  const skip = document.createElement('button')
  skip.textContent = 'Skip'
  const submit = document.createElement('button')
  submit.className = 'primary'
  submit.textContent = 'Answer'
  const answer = (answers) => {
    lockCard(event.id, true)
    if (!send({ t: 'answer', id: event.id, answers })) lockCard(event.id, false)
    else setTimeout(() => lockCard(event.id, false), 8000)
  }
  skip.addEventListener('click', () => answer([]))
  submit.addEventListener('click', () => {
    const answers = event.questions.map((q, qi) => ({
      question: q.question,
      selected: [...picked[qi]],
    }))
    if (answers.every((a) => a.selected.length === 0)) {
      notice('Pick an option first, or tap Skip.', true)
      return
    }
    notice('')
    answer(answers)
  })
  actions.append(skip, submit)
  card.append(actions)

  placeCard(event.id, card)
}

const VERDICTS = {
  allow: '✓ Allowed',
  deny: '✕ Denied',
  expired: '– Expired',
  cancelled: '– Cancelled',
}

function resolvePermissionCard(id, decision) {
  // Every copy, not just the first match.
  for (const card of cardsFor(id)) {
    card.classList.add('done')
    const actions = card.querySelector('.perm-actions')
    if (!actions) continue
    const verdict = document.createElement('span')
    verdict.className = 'perm-verdict'
    verdict.textContent =
      card.dataset.kind === 'question' && decision === 'allow'
        ? '✓ Answered'
        : card.dataset.kind === 'question' && decision === 'deny'
          ? '– Skipped'
          : (VERDICTS[decision] ?? decision)
    actions.replaceWith(verdict)
    // The call's own row now says what happened, and a reload would not show
    // the card either — so after a moment to read the verdict it goes.
    setTimeout(() => {
      card.classList.add('fade')
      setTimeout(() => card.remove(), 350)
    }, 1200)
  }
}

function send(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload))
    return true
  }
  notice('Not connected. Reconnecting…', true)
  return false
}

/**
 * Load the committed transcript from disk into an empty message list.
 *
 * This is the only source of already-finished messages — the server never
 * replays them over the socket, so reloading here after a reconnect is what
 * fills in whatever happened while the phone was away.
 */
async function loadTranscript() {
  // Fetch first, then swap the list in one go. Wiping first left a window in
  // which a reconnect could render cards into a list about to be replaced, and
  // two overlapping loads could interleave two copies of the conversation.
  const gen = ++state.loadGen
  let page = null
  let failed = false
  if (state.sessionId) {
    try {
      page = await api(
        `/api/projects/${state.project.id}/sessions/${state.sessionId}/transcript`,
      )
    } catch {
      failed = true
    }
  }
  if (gen !== state.loadGen) return

  messagesEl().textContent = ''
  clearStream()
  state.earliestOffset = 0
  $('load-earlier').hidden = true
  if (page) {
    state.totalMessages = page.totalMessages
    state.earliestOffset = page.messages.length
    for (const message of page.messages) appendMessage(message)
    $('load-earlier').hidden = !page.hasEarlier
  } else if (failed && state.totalMessages > 0) {
    // A brand-new conversation has no transcript yet; that is not an error.
    notice('Could not load the transcript.', true)
  }
  // Waiting requests go back at the bottom, drawn fresh from state rather than
  // carried over from the old DOM — carrying them over is how a card the
  // server had long forgotten used to survive every reconnect.
  for (const event of state.pending.values()) renderPending(event)
  scrollToBottom(true)
}

/**
 * Keep the open conversation in the URL.
 *
 * Android discards background tabs freely once the screen has been off a
 * while; with this, coming back lands in the same conversation instead of the
 * project list.
 */
function saveLocation() {
  if (state.view !== 'chat' || !state.project) {
    if (location.hash) history.replaceState(null, '', location.pathname)
    return
  }
  const params = new URLSearchParams({ p: state.project.id, s: state.sessionId ?? 'new' })
  history.replaceState(null, '', `#${params}`)
}

async function openChat(sessionId, title, model = null) {
  state.sessionId = sessionId
  state.totalMessages = 0
  // Per-conversation state: the command list and mode belong to the run, not the
  // app, so a stale one must not leak across conversations.
  state.commands = null
  state.mode = null
  state.pending.clear()
  state.bgTasks = []
  state.model = model
  state.effort = null
  state.attachments = []
  renderAttachments()
  $('slash-palette').hidden = true
  $('chat-title').textContent = title || 'New conversation'
  renderChips()
  notice('')
  setBusy(false)
  show('chat')
  await loadTranscript()
  connect()
}

async function loadEarlier() {
  const button = $('load-earlier')
  button.disabled = true
  try {
    const page = await api(
      `/api/projects/${state.project.id}/sessions/${state.sessionId}/transcript?before=${state.earliestOffset}`,
    )
    const scroll = $('chat-scroll')
    const before = scroll.scrollHeight
    // Built in a detached list so the page groups like any other, then
    // moved in above what is already shown.
    const older = document.createElement('div')
    for (const message of page.messages) appendMessage(message, older)
    messagesEl().prepend(...older.children)
    state.earliestOffset += page.messages.length
    button.hidden = !page.hasEarlier
    scroll.scrollTop += scroll.scrollHeight - before
  } finally {
    button.disabled = false
  }
}

// ------------------------------------------------------------------ websocket

function connect({ isReconnect = false } = {}) {
  if (state.ws) {
    state.ws.onclose = null
    state.ws.close()
  }
  clearTimeout(state.reconnectTimer)

  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const session = state.sessionId || 'new'
  const ws = new WebSocket(
    `${proto}://${location.host}/ws?project=${encodeURIComponent(state.project.id)}&session=${encodeURIComponent(session)}`,
  )
  state.ws = ws

  ws.onopen = () => {
    if (state.ws !== ws) return
    state.connected = true
    renderStatus()
    notice('')
    // The server replays every request it is still waiting on right after
    // this, so whatever we held is rebuilt from that — anything it no longer
    // has is gone for good and its card must not stay tappable.
    state.pending.clear()
    for (const card of messagesEl().querySelectorAll('.perm:not(.done)')) card.remove()
    // Anything that happened while the socket was down is on disk, not in the
    // socket — re-read it rather than showing a conversation with a hole in it.
    if (isReconnect && state.sessionId) void loadTranscript()
  }

  ws.onmessage = (raw) => {
    // A replaced socket can still deliver a frame or two; acting on them would
    // resurrect state the new socket has already superseded.
    if (state.ws !== ws) return
    // Any traffic proves the socket is alive; the watchdog below reads this.
    state.lastEventAt = Date.now()
    let event
    try {
      event = JSON.parse(raw.data)
    } catch {
      return
    }
    handleEvent(event)
  }

  ws.onclose = (ev) => {
    state.connected = false
    if (state.view !== 'chat') return
    renderStatus()
    // 4001 is our own "refused on purpose, reason already sent" code. Retrying
    // would spin forever and overwrite that explanation with a misleading
    // "connection lost". Protocol-level closes (1008/1009 for an oversized
    // frame, etc.) are *not* in this list — those should reconnect.
    if (ev.code === 4001) {
      $('chat-status').textContent = 'not connected'
      return
    }
    notice('Connection lost. Reconnecting…', true)
    state.reconnectTimer = setTimeout(() => connect({ isReconnect: true }), 2000)
  }

  ws.onerror = () => {
    $('chat-status').textContent = 'error'
  }
}

function handleEvent(event) {
  switch (event.t) {
    case 'session':
      state.sessionId = event.sessionId
      saveLocation()
      break

    case 'background':
      state.bgTasks = Array.isArray(event.tasks) ? event.tasks : []
      renderStatus()
      break

    case 'busy':
      setBusy(event.busy)
      if (!event.busy) clearStream()
      break

    case 'init':
      if (event.model) state.model = event.model
      if (event.permissionMode) state.mode = event.permissionMode
      renderChips()
      break

    case 'mode':
      state.mode = event.mode
      renderChips()
      break

    case 'progress':
      state.currentTool = `${event.tool} ${event.seconds}s`
      renderStatus()
      break

    case 'commands':
      state.commands = event.commands
      renderPalette()
      break

    case 'effort':
      state.effort = event.current ?? null
      renderChips()
      break

    case 'effortInfo':
      state.effort = event.current ?? state.effort
      renderChips()
      showEffortSheet(event)
      break

    case 'models':
      showModelSheet(event.models, event.current)
      break

    case 'thinking':
      state.currentTool = 'thinking'
      renderStatus()
      ensureStream().textContent = 'thinking…'
      break

    case 'partial': {
      const el = ensureStream()
      if (el.dataset.mode !== 'text') {
        el.dataset.mode = 'text'
        el.textContent = ''
      }
      el.textContent += event.text
      scrollToBottom()
      break
    }

    case 'message': {
      // The completed message supersedes whatever was streamed for it.
      clearStream()
      appendMessage(event.message)
      // Name the tool as soon as it is requested — tool_progress only arrives
      // for calls slow enough to need it, which is too late to feel responsive.
      const tool = event.message.blocks.find((b) => b.kind === 'tool_use')
      if (tool) {
        state.currentTool = tool.name
        renderStatus()
      }
      scrollToBottom()
      break
    }

    case 'permission':
    case 'question': {
      clearStream()
      const isNew = !state.pending.has(event.id)
      state.pending.set(event.id, event)
      renderPending(event)
      // Buzz for a request you haven't seen, not for every reconnect replay.
      if (isNew && navigator.vibrate) navigator.vibrate(40)
      break
    }

    case 'permission_resolved':
      state.pending.delete(event.id)
      resolvePermissionCard(event.id, event.decision)
      break

    case 'result':
      clearStream()
      if (state.interrupting) {
        // An interrupted turn reports isError, which is not something to alarm
        // the user about — they are the one who pressed Stop.
        notice('Stopped.')
        state.interrupting = false
      } else if (event.isError) {
        notice(`Turn ended with an error: ${event.text ?? 'unknown'}`, true)
      }
      break

    case 'error':
      notice(event.message, true)
      break

    case 'notice':
      notice(event.message)
      break

    default:
      break
  }
}

function ensureStream() {
  if (!state.streamEl) {
    const el = document.createElement('div')
    el.className = 'streaming'
    messagesEl().append(el)
    state.streamEl = el
  }
  return state.streamEl
}

function clearStream() {
  if (state.streamEl) {
    state.streamEl.remove()
    state.streamEl = null
  }
}

// -------------------------------------------------------------------- wiring

// ------------------------------------------------------------------ attachments

/** Long edge cap. Matches what the current models accept at full resolution. */
const MAX_IMAGE_EDGE = 2576

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Shrink oversized photos before upload.
 *
 * A 4000 px phone photo costs a lot of vision tokens for detail the model cannot
 * use, and makes the upload slow over a phone connection. Images already within
 * the cap are sent untouched so nothing is recompressed needlessly.
 */
async function downscaleImage(file) {
  if (!file.type.startsWith('image/')) return { blob: file, mime: file.type, name: file.name }
  // GIFs may be animated; re-encoding would silently flatten them.
  if (file.type === 'image/gif') return { blob: file, mime: file.type, name: file.name }

  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) return { blob: file, mime: file.type, name: file.name }

  const longest = Math.max(bitmap.width, bitmap.height)
  if (longest <= MAX_IMAGE_EDGE) {
    bitmap.close?.()
    return { blob: file, mime: file.type, name: file.name }
  }

  const scale = MAX_IMAGE_EDGE / longest
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close?.()

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
  if (!blob) return { blob: file, mime: file.type, name: file.name }
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg'
  return { blob, mime: 'image/jpeg', name }
}

function renderAttachments() {
  const wrap = $('attachments')
  wrap.textContent = ''
  if (state.attachments.length === 0) {
    wrap.hidden = true
    return
  }
  for (const att of state.attachments) {
    const chip = document.createElement('span')
    chip.className = `att${att.pending ? ' busy' : ''}${att.error ? ' bad' : ''}`

    const name = document.createElement('span')
    name.className = 'att-name'
    name.textContent = `${att.isImage ? '🖼 ' : '📄 '}${att.name}`
    chip.append(name)

    const size = document.createElement('span')
    size.className = 'att-size'
    size.textContent = att.error ? att.error : att.pending ? 'uploading…' : humanSize(att.size)
    chip.append(size)

    const x = document.createElement('button')
    x.className = 'att-x'
    x.textContent = '×'
    x.setAttribute('aria-label', `Remove ${att.name}`)
    x.addEventListener('click', () => {
      state.attachments = state.attachments.filter((a) => a !== att)
      renderAttachments()
    })
    chip.append(x)
    wrap.append(chip)
  }
  wrap.hidden = false
}

async function uploadFiles(files) {
  for (const file of files) {
    const entry = {
      name: file.name,
      size: file.size,
      isImage: file.type.startsWith('image/'),
      pending: true,
      error: null,
      id: null,
    }
    state.attachments.push(entry)
    renderAttachments()

    try {
      const prepared = await downscaleImage(file)
      const res = await fetch(`/api/projects/${state.project.id}/attachments`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/octet-stream',
          'x-filename': encodeURIComponent(prepared.name).replace(/%20/g, ' '),
          'x-mime': prepared.mime || 'application/octet-stream',
        },
        body: prepared.blob,
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'upload failed')
      entry.id = body.id
      entry.name = body.name
      entry.size = body.size
      entry.isImage = body.isImage
      entry.pending = false
    } catch (err) {
      entry.pending = false
      entry.error = err instanceof Error ? err.message : 'failed'
    }
    renderAttachments()
  }
}

// ------------------------------------------------- sheets, palette, switchers

function openSheet(title, build) {
  $('sheet-title').textContent = title
  const body = $('sheet-body')
  body.textContent = ''
  build(body)
  $('sheet').hidden = false
}

function closeSheet() {
  $('sheet').hidden = true
}

function sheetOption(label, description, selected, onPick) {
  const button = document.createElement('button')
  button.className = selected ? 'sheet-opt on' : 'sheet-opt'
  const l = document.createElement('span')
  l.className = 'opt-label'
  l.textContent = label
  button.append(l)
  if (description) {
    const d = document.createElement('span')
    d.className = 'opt-desc'
    d.textContent = description
    button.append(d)
  }
  button.addEventListener('click', () => {
    closeSheet()
    onPick()
  })
  return button
}

function showModeSheet() {
  openSheet('Permission mode', (body) => {
    for (const mode of MODE_ORDER) {
      body.append(
        sheetOption(MODE_LABELS[mode], MODE_HELP[mode], state.mode === mode, () => {
          send({ t: 'setMode', mode })
        }),
      )
    }
  })
}

const EFFORT_HELP = {
  low: 'Fastest and cheapest. Minimal thinking.',
  medium: 'Balanced speed and depth.',
  high: 'Thinks harder on difficult problems.',
  xhigh: 'Deeper reasoning for hard, long-running work.',
  max: 'Deepest reasoning; can use a lot of tokens. This session only.',
}

/**
 * Effort picker. Same semantics as `/effort` in the terminal: applies to the
 * running session right away and is saved as this model's default for new
 * sessions — except `max`, which is session-only.
 */
function showEffortSheet({ current, levels, model }) {
  openSheet('Effort', (body) => {
    if (levels.length === 0) {
      const p = document.createElement('p')
      p.className = 'muted tiny'
      p.textContent = 'This model has no effort setting.'
      body.append(p)
      return
    }
    for (const level of levels) {
      body.append(
        sheetOption(level, EFFORT_HELP[level] ?? '', level === current, () => {
          send({ t: 'setEffort', level })
        }),
      )
    }
    const p = document.createElement('p')
    p.className = 'muted tiny'
    p.textContent = `Like /effort: takes effect on the next request and becomes the default for ${model ? shortModel(model) : 'this model'} (max stays session-only).`
    body.append(p)
  })
}

function showModelSheet(models, current) {
  openSheet('Model', (body) => {
    if (models.length === 0) {
      const p = document.createElement('p')
      p.className = 'muted tiny'
      p.textContent = 'Could not read the model list.'
      body.append(p)
      return
    }
    for (const model of models) {
      body.append(
        sheetOption(
          model.displayName || model.value,
          model.description,
          model.value === (current ?? state.model),
          () => send({ t: 'setModel', model: model.value }),
        ),
      )
    }
  })
}

/**
 * Slash command list, shown while the composer holds a bare `/word`.
 *
 * Commands run as ordinary prompt text — the CLI interprets them locally, so
 * `/context` and friends cost nothing and never reach the model.
 */
function renderPalette() {
  const palette = $('slash-palette')
  const value = $('prompt').value
  const match = /^\/(\S*)$/.exec(value)

  if (!match) {
    palette.hidden = true
    return
  }
  if (state.commands === null) {
    // Fetching also spins up the run, so only ask once the intent is clear.
    send({ t: 'commands' })
    palette.hidden = true
    return
  }

  const term = match[1].toLowerCase()
  const hits = state.commands
    .filter((c) => c.name.toLowerCase().includes(term))
    .slice(0, 40)

  palette.textContent = ''
  if (hits.length === 0) {
    palette.hidden = true
    return
  }
  for (const command of hits) {
    const button = document.createElement('button')
    const name = document.createElement('span')
    name.className = 'cmd'
    name.textContent = `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''}`
    button.append(name)
    if (command.description) {
      const desc = document.createElement('span')
      desc.className = 'cmd-desc'
      desc.textContent = command.description
      button.append(desc)
    }
    button.addEventListener('click', () => {
      const el = $('prompt')
      // Leave the cursor after a trailing space when the command takes an arg.
      el.value = `/${command.name}${command.argumentHint ? ' ' : ''}`
      palette.hidden = true
      el.focus()
      autoGrow()
    })
    palette.append(button)
  }
  palette.hidden = false
}

function autoGrow() {
  const el = $('prompt')
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`
}

function submitPrompt() {
  const el = $('prompt')
  const text = el.value.trim()
  const ready = state.attachments.filter((a) => a.id && !a.error)

  if (!text && ready.length === 0) return
  if (state.attachments.some((a) => a.pending)) {
    notice('Still uploading — one moment.', true)
    return
  }
  // The server caps WebSocket frames at 1 MiB. Catching it here gives a real
  // explanation instead of a socket that closes for no visible reason.
  if (text.length > 512_000) {
    notice(`That message is too long (${Math.round(text.length / 1024)} kB). Attach it as a file instead.`, true)
    return
  }

  state.interrupting = false
  notice('')
  if (!send({ t: 'prompt', text, attachments: ready.map((a) => a.id) })) return

  // Echo locally so the bubble appears immediately, mirroring what the server
  // will build: image markers plus the text.
  const blocks = ready
    .filter((a) => a.isImage)
    .map(() => ({ kind: 'image', mime: 'image' }))
  const noteLines = ready.filter((a) => !a.isImage).map((a) => `📄 ${a.name}`)
  const shown = [text, ...noteLines].filter(Boolean).join('\n')
  if (shown) blocks.push({ kind: 'text', text: shown })
  appendMessage({ role: 'user', blocks, ts: Date.now() })

  el.value = ''
  state.attachments = []
  renderAttachments()
  $('slash-palette').hidden = true
  autoGrow()
  setBusy(true)
  scrollToBottom(true)
}

$('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const token = $('login-token').value
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ token }),
  })
  if (!res.ok) {
    $('login-error').textContent = 'That token was not accepted.'
    $('login-error').hidden = false
    return
  }
  $('login-error').hidden = true
  $('login-token').value = ''
  show('projects')
  await loadProjects(true)
})

$('project-search').addEventListener('input', renderProjects)
$('projects-refresh').addEventListener('click', () => loadProjects(true))

$('project-new').addEventListener('click', async () => {
  const name = window.prompt('New project folder name')
  if (name === null) return
  const trimmed = name.trim()
  if (!trimmed) return
  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ name: trimmed }),
    })
    const body = await res.json()
    if (!res.ok) {
      window.alert(body.error ?? 'Could not create that folder.')
      return
    }
    await loadProjects(true)
    // Straight into a new conversation — that is why you made the folder.
    state.project = body
    $('sessions-title').textContent = body.name
    $('sessions-path').textContent = body.path
    $('session-list').textContent = ''
    $('sessions-empty').hidden = false
    show('sessions')
  } catch {
    window.alert('Could not reach the server.')
  }
})
$('new-conversation').addEventListener('click', () => openChat(null, 'New conversation'))
$('load-earlier').addEventListener('click', loadEarlier)
$('send').addEventListener('click', submitPrompt)
$('stop').addEventListener('click', () => {
  state.interrupting = true
  notice('Stopping…')
  send({ t: 'interrupt' })
})
$('prompt').addEventListener('input', () => {
  autoGrow()
  renderPalette()
})
$('attach').addEventListener('click', () => $('file-input').click())
$('file-input').addEventListener('change', async (ev) => {
  const files = [...ev.target.files]
  ev.target.value = '' // so picking the same file twice still fires
  if (files.length > 0) await uploadFiles(files)
})
$('chip-mode').addEventListener('click', showModeSheet)
$('chip-model').addEventListener('click', () => send({ t: 'models' }))
$('chip-effort').addEventListener('click', () => send({ t: 'effort' }))
$('sheet-close').addEventListener('click', closeSheet)
$('sheet').addEventListener('click', (ev) => {
  // Tap the backdrop to dismiss, but not the panel itself.
  if (ev.target === $('sheet')) closeSheet()
})
$('prompt').addEventListener('keydown', (ev) => {
  // Enter inserts a newline on a phone keyboard; Ctrl/Cmd+Enter sends.
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault()
    submitPrompt()
  }
})

for (const button of document.querySelectorAll('[data-back]')) {
  button.addEventListener('click', () => {
    const target = button.dataset.back
    if (target === 'projects') {
      show('projects')
      void loadProjects(true)
    } else {
      if (state.ws) {
        state.ws.onclose = null
        state.ws.close()
        state.ws = null
      }
      clearTimeout(state.reconnectTimer)
      void openProject(state.project)
    }
  })
}

/**
 * Coming back from the background.
 *
 * The socket is reconnected *unconditionally* here. When Android suspends the
 * tab the WebSocket goes half-open: readyState still reads OPEN and no close
 * event ever fires, so trusting readyState meant we never reconnected, never
 * reloaded the transcript, and a reply that finished while the phone was away
 * was simply never displayed — the UI sat on "working" forever.
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  if (state.view === 'projects') void loadProjects(true)
  if (state.view === 'chat' && state.project) {
    connect({ isReconnect: true })
  }
})

// The network coming back (Wi-Fi ↔ mobile handover, tunnel reconnect) and a
// page restored from the back/forward cache both leave a dead socket behind.
window.addEventListener('online', () => {
  if (state.view === 'chat' && state.project) connect({ isReconnect: true })
})
window.addEventListener('pageshow', (ev) => {
  if (ev.persisted && state.view === 'chat' && state.project) connect({ isReconnect: true })
})

/**
 * Watchdog for a socket that dies while the page is in the foreground.
 *
 * Only fires while a turn is in flight: a running turn streams partials and
 * progress events constantly, so a full minute of silence means the connection
 * is gone even though no close event arrived. Idle silence is normal and is
 * deliberately left alone.
 */
setInterval(() => {
  if (document.visibilityState !== 'visible') return
  if (state.view !== 'chat' || !state.project || !state.busy) return
  if (!state.lastEventAt || Date.now() - state.lastEventAt < 60_000) return
  notice('Connection went quiet — reconnecting…', true)
  connect({ isReconnect: true })
}, 15_000)

/**
 * Reopen the conversation saved in the URL, e.g. after Android discarded the
 * tab while the screen was off. Any failure just leaves the project list up.
 */
async function restoreChat(projectId, sessionId) {
  if (!projectId) return false
  const project = state.projects.find((p) => p.id === projectId)
  if (!project) return false
  try {
    state.project = project
    $('sessions-title').textContent = project.name
    $('sessions-path').textContent = project.path
    if (!sessionId || sessionId === 'new') {
      await openChat(null, 'New conversation')
      return true
    }
    const data = await api(`/api/projects/${project.id}/sessions`)
    const session = data.sessions.find((s) => s.sessionId === sessionId)
    await openChat(sessionId, session?.title ?? 'Conversation', session?.model ?? null)
    return true
  } catch {
    return false
  }
}

async function boot() {
  try {
    const me = await fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json())
    if (me.authed) {
      // Read before show() rewrites the URL.
      const saved = new URLSearchParams(location.hash.slice(1))
      show('projects')
      await loadProjects()
      await restoreChat(saved.get('p'), saved.get('s'))
      return
    }
  } catch {
    // fall through to login
  }
  show('login')
}

void boot()
