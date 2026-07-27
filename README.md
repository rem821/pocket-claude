# pocket-claude

Drive [Claude Code](https://code.claude.com) on your own machine from your phone, over Tailscale.

Your projects, your filesystem, your Claude Code login. The conversation runs as a
process on your desktop; the phone is just a window into it.

```
phone ──tailnet──▶ pocket-claude (node)
                        │  spawns
                        ▼
                   claude ──https──▶ api.anthropic.com
                        │
                        ▼
              your project files + ~/.claude transcripts
```

## Why this exists

Your development environment lives on your desktop — the checkouts, the toolchain,
the running services, the MCP servers, the half-finished branch. pocket-claude lets
you keep working on it from a phone without moving any of that anywhere: same
files, same tools, same Claude Code setup, driven from the couch or a train.

Useful for picking up a long-running task while away from the desk, steering
something you kicked off before you left, or just reading back what happened.

Claude Code also ships [Remote Control](https://code.claude.com/docs/en/remote-control),
which does much the same job with far less setup — **try that first.** It syncs the
session through Anthropic's servers so you can pick it up in the Claude app or at
claude.ai/code on any device.

pocket-claude is the self-hosted alternative: the session and its transcript stay
on your machine, and the UI is served over your own private network rather than
through a hosted surface. That is a difference in *architecture*, not a privacy
guarantee — prompts, responses and tool results are still sent to
`api.anthropic.com` for inference exactly as they are in any Claude Code session,
and are handled under whatever terms and data-retention policy apply to your
account. If you have specific compliance requirements, check them against
[Anthropic's data usage documentation](https://code.claude.com/docs/en/data-usage)
rather than assuming self-hosting the UI satisfies them.

## What it does

- **Projects** — every subdirectory of `PROJECTS_ROOT` is a project. Search box for
  when there are a lot of them; `＋` creates a new folder.
- **Conversations** — lists your existing Claude Code sessions per project, titled
  from the transcript, newest first. Resume one or start a new one.
- **Streaming** — replies arrive token by token, with a spinner, a live elapsed
  counter, and the name of the tool currently running.
- **Permission prompts on the phone** — when Claude wants to run Bash or edit a
  file, an Allow/Deny card appears and the run blocks until you tap.
- **Permission modes** — `Ask`, `Auto-edit`, `Auto`, and **plan mode**, switchable
  mid-conversation.
- **Model switcher** — pick between the models your account has.
- **Slash commands** — type `/` for a filterable list of everything your install
  offers, including your own project commands and skills.
- **Questions** — `AskUserQuestion` renders as tappable options.
- **Attachments** — photos and files from the camera, gallery or Files app. Images
  are sent as real vision input; other files are saved and read with the Read tool.
- **Survives interruptions** — lock your phone mid-turn; the work continues on the
  desktop and the transcript is re-read when you come back.

Add it to your home screen for an app-like launcher.

## Requirements

- Linux or macOS with **Node 22+**
- **Claude Code** installed and logged in (`claude` on your PATH, `claude auth status`
  showing a claude.ai account — an API key won't do, see below)
- **Tailscale** on both the machine and the phone, or some other private path
  between them
- systemd, if you want the autostart script (otherwise run it however you like)

pocket-claude reuses your existing Claude Code login, so usage bills the same
subscription as the terminal and there is **no `ANTHROPIC_API_KEY` to configure**.

## Install

```bash
git clone <your-fork-url> pocket-claude
cd pocket-claude
npm install
cp .env.example .env
```

Edit `.env` — at minimum a token and where your projects live:

```bash
openssl rand -hex 24        # paste into POCKET_TOKEN
```

```ini
POCKET_TOKEN=<the value you just generated>
PROJECTS_ROOT=/home/you/projects
HOST=auto
```

Then build and run:

```bash
npm run build
npm start
```

It prints the address it bound. Open that on your phone and enter the token once.

### Run it at boot

```bash
./scripts/install-service.sh
```

That detects your `node`, writes a systemd **user** unit with real paths, enables
[lingering](https://www.freedesktop.org/software/systemd/man/loginctl.html) so it
survives a reboot without you logging in, and starts it.

```bash
systemctl --user status pocket-claude
journalctl --user -u pocket-claude -f
```

A user service is deliberate — it has to run as you, because it uses your Claude
Code login and your `~/.claude` transcripts.

## Configuration

All via `.env` (or real environment variables, which take precedence).

| Variable | Default | Meaning |
| --- | --- | --- |
| `POCKET_TOKEN` | *required* | Shared secret typed once per device |
| `PROJECTS_ROOT` | `~/projects` | Folder whose subdirectories become projects |
| `HOST` | `127.0.0.1` | `auto` for the Tailscale IP, or an explicit address |
| `PORT` | `7420` | |
| `CLAUDE_HOME` | `~/.claude` | Where Claude Code keeps transcripts |
| `CLAUDE_BIN` | auto-detected | The `claude` binary to spawn |
| `INCLUDE_EXTERNAL_HISTORY` | `false` | Also list projects with history outside `PROJECTS_ROOT` |
| `MAX_RUNNERS` | `8` | Concurrent conversations (each is a `claude` subprocess) |
| `UPLOAD_QUOTA_BYTES` | `256 MB` | Per-project upload budget; oldest pruned first |
| `ALLOWED_ORIGINS` | *(empty)* | Extra browser origins allowed to connect |
| `COOKIE_SECURE` | `false` | Add `Secure` to the cookie — set when serving over HTTPS |
| `LOG_LEVEL` | `info` | `fatal` … `trace` |

`HOST=auto` runs `tailscale ip -4` at startup. Binding the tailnet address
specifically keeps the server off your LAN and Wi-Fi interfaces entirely; it falls
back to loopback with a warning if Tailscale isn't there.

## Security

**The token is the only authentication, and it is equivalent to shell access.**
Anyone on your tailnet who has it can make Claude run commands as you. Treat it
like an SSH key: long, unique, not shared, rotated if it leaks (change
`POCKET_TOKEN` and restart — every device then re-enters it).

What is in place:

- **Origin enforcement.** A browser request carrying a foreign `Origin` is refused
  on the WebSocket upgrade and on every state-changing HTTP method. Without this,
  `SameSite=Lax` declining to attach the cookie is the *only* thing standing
  between an arbitrary web page and code execution on your machine.
- **A strict CSP** (`default-src 'none'` with each need enumerated), plus
  `nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.
- **Caps** on concurrent runners, per-project upload bytes, and WebSocket frame
  size (1 MiB — attachments go over HTTP, not the socket).
- **Attachment ids are scoped to their project and consumed on use**, so one
  cannot be replayed or pulled into a different conversation.

Other things worth knowing:

- The cookie is `HttpOnly` and `SameSite=Lax`, but **not** `Secure` by default,
  because the default transport is plain HTTP over the tailnet. Set
  `COOKIE_SECURE=true` when serving over HTTPS. A tailnet is a private network,
  not an encrypted-in-transit guarantee for the last hop.
- **Login is not rate-limited.** A wrong token costs the attacker 750 ms, but that
  delay is per-request and parallelises freely. The default 48-hex-character token
  makes guessing infeasible; a short one you chose yourself does not.
- **`npm audit` reports three moderate advisories, all from one transitive
  package.** They trace to
  `@anthropic-ai/claude-agent-sdk → @modelcontextprotocol/sdk → @hono/node-server`,
  and the underlying issue is a path traversal in Hono's `serve-static` **on
  Windows** via an encoded backslash. Nothing here imports Hono or serves static
  files through it. `npm audit fix --force` "fixes" it by downgrading the Agent SDK
  by a major version, which is worse — so it is knowingly accepted rather than
  silenced.
- `Auto` mode (`bypassPermissions`) means anything Claude decides to do just runs,
  unattended, while your phone is in your pocket. The chip turns red for a reason.
- Uploaded files land in `<project>/.pocket-uploads/`, so they will appear in
  `git status`. Add that path to your `.gitignore` if it bothers you.
- Your tailnet ACLs still apply. If other people's devices are on your tailnet,
  they can reach the port — the token is what stops them.

### Optional: HTTPS

If you enable **HTTPS Certificates** for your tailnet, you can put it behind
`tailscale serve` and get a real certificate:

```bash
# in .env
HOST=127.0.0.1
```

```ini
# in .env
HOST=127.0.0.1
COOKIE_SECURE=true
```

```bash
tailscale serve --bg --https=443 http://127.0.0.1:7420
```

This is also what unlocks service-worker/offline behaviour, which plain HTTP
disallows.

## How it works

The backend drives [`@anthropic-ai/claude-agent-sdk`](https://code.claude.com/docs/en/agent-sdk)
in **streaming input mode**. That mode is what makes multi-turn conversation,
`interrupt()`, the `canUseTool` permission callback, and the live control requests
(`setPermissionMode`, `setModel`, `supportedCommands`) available at all — a plain
string prompt gives you none of them.

| File | Role |
| --- | --- |
| `src/config.ts` | env loading, path and binary discovery |
| `src/projects.ts` | project discovery, folder creation |
| `src/sessions.ts` | conversation list and titles, cached on (mtime, size) |
| `src/transcript.ts` | transcript JSONL → renderable messages |
| `src/uploads.ts` | attachment staging, image inlining |
| `src/agent.ts` | one runner per project: permissions, modes, interrupt, reaping |
| `src/server.ts` | HTTP API, WebSocket, auth gate |
| `public/` | the entire frontend — no framework, no build step |

### Four invariants that are easy to break

These each cost a real bug to discover. If you change this code, keep them.

**1. The `~/.claude/projects/` directory name is not reversible.** It replaces both
`/` and `_` with `-`, so `my_project` and `my-project` encode identically.
`projects.ts` reads the authoritative `cwd` field out of each transcript instead of
decoding the directory name. Don't "simplify" it back to a string replacement.

**2. The server never replays past messages over the socket.** The transcript on
disk is the single source of truth for anything already committed; the socket
carries only live events, session metadata, and pending permission requests. Add
replay and every message appears twice on top of what the client just loaded.

**3. Never trust `WebSocket.readyState` after the page was backgrounded.** A
suspended mobile tab leaves the socket reading `OPEN` while nothing flows and no
`close` event ever fires. The client reconnects unconditionally on
`visibilitychange`, and a watchdog catches sockets that die while in the foreground.

**4. Don't coerce an unrecognised permission decision to "deny".** It gets reported
to Claude as a deliberate refusal by the user, which is wrong and impossible to
debug. Unknown values are logged and ignored, leaving the card live to tap again.

### Deliberate limits

- **One live conversation per project.** Two runs in one directory would append to
  the same transcript and race. A second connection takes over an idle runner and
  is refused only if the first is genuinely mid-turn.
- **Idle runners are reaped after two minutes** with no client attached, so browsing
  projects doesn't leave a pile of `claude` subprocesses. A turn in flight is never
  reaped — finishing while you're away is the point.
- **`AskUserQuestion` answers ride back on a tool-deny message.** `canUseTool` can
  allow or deny but cannot return a tool *result*, so the chosen options are
  delivered in the denial text, phrased for Claude to treat as the answer. It works,
  but it is a workaround.
- **Sent images render as a marker, not a thumbnail.** The base64 stays server-side;
  echoing it would add megabytes to every transcript load over a phone connection.

## Troubleshooting

**"POCKET_TOKEN is not set"** — you haven't copied `.env.example` to `.env`, or the
service can't read it. The systemd unit uses `EnvironmentFile=`, so the path in the
unit must match where the repo actually is.

**Binds `127.0.0.1` when you asked for `auto`** — `tailscale` isn't on the service's
PATH, or Tailscale is down. Check `tailscale ip -4` by hand.

**"is busy with another conversation"** — that project has a live turn or a pending
permission tap. Open that conversation, or wait for it to finish.

**A conversation appears twice** — resuming the same session from your terminal
while pocket-claude holds it makes Claude Code **fork** it into a new session id.
Both files are real history. Drive a given conversation from one place at a time.

**Nothing happens when Claude wants permission** — check
`journalctl --user -u pocket-claude -f`; every decision is logged with its id.

## Contributing

```bash
npm run dev        # tsx watch, restarts on change
npm run typecheck  # tsc --noEmit
npm run build
```

Frontend changes need only a page reload. Backend changes need a restart
(`systemctl --user restart pocket-claude`), which ends any in-flight turn.

## Licence

[MIT](LICENSE).
