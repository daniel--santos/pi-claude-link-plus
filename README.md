# pi-claude-link

Two-way messaging between [pi coding-agent](https://github.com/earendil-works/pi)
sessions and [Claude Code](https://claude.com/claude-code) sessions.

A pi session running this extension shows up in Claude Code's `/list-agents`, and
the two can message each other **in real time** — no daemon, no broker, no extra
services. It works by speaking Claude Code's own cross-session messaging protocol
(the mechanism behind `/list-agents` + `SendMessage`), so pi and Claude interoperate
natively.

Inspired by [pi-intercom](https://github.com/nicobailon/pi-intercom) (pi↔pi);
pi-claude-link does pi↔Claude.

---

## What you get

- **Pi appears in Claude.** Every pi session auto-registers as a peer — it shows in
  Claude Code's `/list-agents`, and Claude can `SendMessage` to it.
- **Real-time inbound.** A message from Claude is injected into the live pi session
  immediately (idle → starts a turn; busy → steers the current turn), and pi's reply
  is relayed back to the sender automatically.
- **A `claude-link` tool for the pi model:**
  - `claude-link({ action: "list" })` — list reachable Claude sessions
  - `claude-link({ action: "send", to, message })` — send; the reply comes back into this session
  - `claude-link({ action: "ask", to, message })` — send and block until the reply, returned as the tool result
- **`/claude-link`** command to list sessions (and `/claude-link name <n>` to name this session for Claude's `/list-agents`) from the pi UI, plus a bundled skill so
  natural language ("message the other session…") just works.

## Requirements

- **pi coding-agent** — `npm i -g @earendil-works/pi-coding-agent` (or have `pi` on PATH).
- **Node ≥ 20.19 (22+ recommended).** ⚠️ On older Node, pi itself crashes at startup
  with `webidl.util.markAsUncloneable is not a function` (a bundled-undici
  incompatibility). If you see that, run pi under a newer Node (`nvm use 22`). This is
  a pi requirement, not specific to this extension.
- **Claude Code with cross-session messaging enabled.** It's on by default in recent
  builds; if your Claude sessions don't appear in each other's `/list-agents`, start
  them with `CLAUDE_CODE_HARBOR_KITE=1`. (On macOS/Linux pi-claude-link auto-discovers
  Claude's socket directory — usually `/tmp/cc-socks` — and co-locates with it; on
  Windows it binds a named pipe in the same `\\.\pipe\LOCAL\cc-msg-…` shape Claude uses.)
- **OS:** macOS, Linux, and **Windows 11** (Claude Code ≥ 2.1.266 on Windows).

## Install

```bash
pi install git:github.com/alonw0/pi-claude-link
# once published to npm:
#   pi install npm:pi-claude-link
# for local development (from a clone):
#   pi -e /path/to/pi-claude-link/index.ts
```

Then start pi normally — the extension activates on session start. Verify with
`pi list` (should show `pi-claude-link`) or `/reload` inside a running pi session.

Remove with `pi remove pi-claude-link`.

## Usage

**From pi → Claude** (in a pi session):

```
list the claude sessions            → calls claude-link({action:"list"})
message claude-code-7b: build passes → calls claude-link({action:"send", ...})
```

or `/claude-link` to list. Replies arrive back in your pi session automatically.

**`@`-mention a session** (like Claude Code's own `@session`): type `@` in the pi
editor and the live Claude sessions are offered alongside file matches — `@link ask
what the build status is`. The model gets a hidden note naming the mentioned session
and delivers with `claude-link` (`send` or `ask`); `@src/file.ts` still means a file.

**From Claude → pi** (in a Claude Code session):

```
/list-agents            → shows  pi-<dir>
SendMessage to pi-<dir>: "what's the test status?"
```

> Claude's `/list-agents` UI only shows names a **human** chose; an auto-derived
> `pi-<dir>` appears there as "(unnamed session)" (Claude itself can still address it).
> Give the pi session a name so it shows up: `/claude-link name my-pi` in pi. A name set
> before startup via pi's own session name is used too.

The message appears in the pi session in real time; pi's answer is relayed back to
your Claude session.

## Recommended safety setting

Cross-agent messages are untrusted peer input. To require explicit approval for each
inbound message on the Claude side, set in `~/.claude/settings.json`:

```json
{ "crossSessionInbound": "hold" }
```

(`accept` delivers silently, `refuse` opts out.) See **Security** below.

## How it works

A single in-process TypeScript extension (`index.ts`) plus a dependency-free port of
Claude's wire protocol (`claude-protocol.ts`). No build step — pi runs TypeScript
directly.

- **`session_start`** → bind a local endpoint — a Unix socket at
  `‹Claude's socket dir›/cc-socks/<pid>.sock` on macOS/Linux, or a named pipe
  `\\.\pipe\LOCAL\cc-msg-<32 hex>` on Windows — publish a peer key
  (`~/.claude/sessions/<pid>.<sha256(socket)>.key`, mode 0600) and write
  `~/.claude/sessions/<pid>.json`, registering the pi session as a Claude peer.
- **peer auth** (Claude Code ≥ 2.1.266) → before every frame, the sender looks up the
  *target's* key file by hashing the target's socket path and writes one
  `{"type":"auth","token":…}` line; a receiver that published a key drops connections
  without it. pi does both sides (sends auth to Claude, verifies auth from Claude). A
  target with no key file gets a legacy, token-less send.
- **inbound** (a `type:"user"` frame) → strip the `<cross-session-message>` envelope →
  `pi.sendUserMessage(...)` (real-time) + send a delivery receipt + record the sender.
  The sender's display name is resolved from Claude's registry so it matches `/list-agents`.
- **`agent_end`** → relay pi's reply back to the recorded sender(s).
- **`claude-link` tool** → `list` reads Claude's registry (live-filtered); `send`/`ask`
  connect to the target's socket and write a peer frame; replies route back to our
  socket and are injected.
- **`session_shutdown`** → close the endpoint (unlinking the socket file on Unix) and
  remove the registry entry and key file.

There's no broker or daemon — **Claude's session registry is the hub.** Anything else
registered in that hub is also visible to `list`.

## Security

Messages between agents are **peer input, not user authority**:

- On the **Claude** side they arrive as `origin.kind:"peer"` and are subject to the
  `crossSessionInbound` gate (use `"hold"` to approve each one).
- On the **pi** side, injected messages are framed *"from another agent, not your
  user"* — the model is instructed to treat them as peer requests and not as your
  approval.
- Sockets are `0600` inside a `0700` directory (Unix), and named pipes live under
  `\\.\pipe\LOCAL\`, scoped to your logon session (Windows): the boundary is your
  **user account** (a same-user process could already reach these).
- Peer tokens live in `0600` key files in `~/.claude/sessions/`; presenting one proves
  the sender can read your files — the same "same user" boundary, enforced on the
  wire (this is what replaces `SO_PEERCRED` for named pipes).
- **Do not wire this extension to external/automated inputs.** It is a path for
  untrusted content to reach a permissioned agent — keep the input side to things a
  human sends.

## Development / testing

Extensions are plain TypeScript run in-process (no build). The `test/` harnesses drive
a real pi rpc session end-to-end; run them under a pi-compatible Node:

```bash
npm test                  # transport unit tests (no pi needed): endpoint + send/close
# override how pi is launched if `pi` on PATH isn't on a new enough Node:
#   export PI_CMD="/path/to/node22 /path/to/pi/dist/cli.js"
npm run test:reg          # registration + cleanup (launches a real pi rpc session)
npm run test:roundtrip    # inbound relay + outbound tool
```

`dev-run.sh` (bash) / `dev-run.ps1` (PowerShell) launch pi with the extension loaded
for interactive testing.

Enable debug logging with `PI_CLAUDE_LINK_DEBUG=1` or by creating a sentinel file in
your temp dir (`touch /tmp/pi-claude-link-debug.on`, or on Windows
`New-Item "$env:TEMP\pi-claude-link-debug.on"`); logs go to
`<tmpdir>/pi-claude-link-debug.log`.

## Compatibility

Verified against **pi-coding-agent 0.80.6** and **Claude Code 2.1.224** (macOS/Linux),
and **pi-coding-agent 0.85.1** / **Claude Code 2.1.270** on **Windows 11**. Claude Code
**≥ 2.1.266** requires the peer-auth handshake described above; older builds ignore the
key files and still work. The Claude side relies on its cross-session messaging
protocol; if a future Claude release changes it, `claude-protocol.ts` is the single
place to update.

Platform differences are confined to `claude-protocol.ts`:

| | macOS / Linux | Windows |
|---|---|---|
| Endpoint | Unix socket `‹cc-socks›/<pid>.sock` | Named pipe `\\.\pipe\LOCAL\cc-msg-<32 hex>` |
| Peer address | `uds:/…/<pid>.sock` | `uds:\\.\pipe\LOCAL\cc-msg-…` |
| Key-file hash input | `path.resolve(socket)` | `\\.\pipe\local\cc-msg-…` (lower-cased) |
| `procStart` | `ps -o lstart` text (`procStart`) | FILETIME via `Get-Process` (`procStartFt` in the key file) |
| Debug files | `/tmp/pi-claude-link-debug.*` | `%TEMP%\pi-claude-link-debug.*` |

## More

- [SECURITY.md](./SECURITY.md) — trust model and how to report a vulnerability
- [CONTRIBUTING.md](./CONTRIBUTING.md) — layout and how to run the tests
- [CHANGELOG.md](./CHANGELOG.md) — release notes

## License

[MIT](./LICENSE)
