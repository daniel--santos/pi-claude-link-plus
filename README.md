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
and **pi-coding-agent 0.85.1** / **Claude Code 2.1.270–2.1.272** on **Windows 11**. Claude Code
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

## Hacking guide — everything you need to change the code or add features

Claude Code's cross-session protocol is undocumented; what follows was reverse-engineered
from Claude Code **2.1.270** (Windows 11), re-checked unchanged on **2.1.272**, and verified live, so you don't have to
rediscover it. Function names in parentheses are the minified names in that build —
useful when grepping the binary.

### 1. Claude's session registry — `~/.claude/sessions/`

Two files per live session:

| File | Content |
|---|---|
| `<pid>.json` | `{ pid, sessionId, cwd, startedAt, procStart, version, peerProtocol: 1, kind: "interactive", entrypoint: "cli" \| "sdk-cli" \| "pi", messagingSocketPath, name, nameSource: "user" \| "auto" \| "derived", status: "idle" \| "busy" \| "shell" \| … }` |
| `<pid>.<sha256(canonical socket)>.key` | `{ peerToken: <32 hex>, procStart? \| procStartFt?, pidDomain? }`, mode `0600` (regex `^(\d+)\.[0-9a-f]{64}\.key$`) |

- **Liveness** is *not* the file: readers connect to `messagingSocketPath` with a short
  timeout (`socketLive`). Stale `.json` files from killed processes are common — a
  peer that dies without `session_shutdown` leaves both files behind
  (`deregisterPeer(pid, sock)` cleans them).
- **`procStart`** guards against pid reuse. Unix: `ps -o lstart` text. Windows: the
  process creation time as a FILETIME string (100 ns ticks since 1601, e.g.
  `134334483310213237`) — written as `procStart` in the `.json` but as `procStartFt`
  in the `.key` (Claude's `y2()` splits by platform). Claude compares them with
  `SSe()`: equal, or both numeric and on the same side of `3e17` (FILETIME vs
  epoch-ms heuristic), so an exact match isn't required for a live peer.
- **`nameSource` decides what humans see.** Claude's `/list-agents` UI withholds names
  no human chose (`"auto"`, `"derived"` → shown as *(unnamed session)*), while the
  model-facing `ListAgents` shows every name. Register `"user"` when a person picked
  the name (`/claude-link name …`, pi's session name, or a rename frame from Claude).

### 2. Transport

| | macOS / Linux | Windows |
|---|---|---|
| Endpoint | Unix socket in Claude's dir: `/tmp/cc-socks[-uid]`, `/private/tmp/cc-socks[-uid]`, `/run/user/<uid>/cc-socks`, termux `…/usr/tmp/cc-socks[-uid]`; our file `<pid>.sock`, `0600` in `0700` | Named pipe `\\.\pipe\LOCAL\cc-msg-<32 hex>` (Claude's own shape; `LOCAL\` scopes it to the logon session) |
| "Canonical" peer path (`X$n`, `Bfe`) | a `.sock` in one of those dirs, owner-uid checked (`s0`) | pipe name matching `^(?:LOCAL\\)?cc-msg-[0-9a-f]{32}$` (case-insensitive) |
| Address in frames | `uds:/…/<pid>.sock` | `uds:\\.\pipe\LOCAL\cc-msg-…` (pipe regex `^[\\/]{2}[.?][\\/]pipe[\\/]`) |

Why we mirror Claude's pipe name instead of inventing one: Claude only sends delivery
receipts / accepts replies to addresses it considers canonical. Node gotchas on
Windows: `server.listen("\tmp\x.sock")` fails with `EACCES` (only `\\.\pipe\…` binds);
`net.connect({path})` works for pipes unchanged; `mkdir`/`chmod`/`unlink` are
meaningless for pipes (skip them, see `isPipePath`).

Other address schemes exist in the binary (`bridge:` for Remote Control, `did:`,
`sid:<sessionId>` behind the `tengu_session_stable_address` flag) — not needed for a
local peer, but `canonicalSockPath` must return `undefined` for them.

### 3. Wire format

Newline-delimited JSON over the socket; Claude drops a connection past **1 MiB**
without a newline. One connection per message. Claude's sender (`d1p`) writes, half-closes,
and resolves only when the socket fully **closes** (5 s timeout) — so a receiver must
`end()` its side on `end` and must not use `allowHalfOpen` (see `test/send-close.mjs`).

```jsonc
// auth preamble — REQUIRED when the target published a .key (Claude >= 2.1.266)
{"type":"auth","token":"<target's peerToken>"}
// user message
{"msgV":1,"msg_id":"<uuid>","type":"user","priority":"next","from":"uds:<sender sock>",
 "session_id":"<optional>","message":{"role":"user","content":"<envelope>"}}
// delivery receipt (send it back to `from` after injecting)
{"msgV":1,"msg_id":"<uuid>","type":"control","action":"peer_message_status",
 "status":"delivered","reason":"…","from":"uds:<our sock>","orig_msg_id":"<their msg_id>"}
// Claude renamed us (a human used /rename on a peer) — update name + nameSource:"user"
{"type":"control","action":"rename","name":"…"}
```

`content` is wrapped in an envelope: `<cross-session-message from="uds:…" from-name="…"
from-mode="…">\n<body>\n</cross-session-message>`, with `</cross-session-message` inside
the body escaped as `<\/…`. Display names should be resolved from the **registry** by
socket (`peerNameBySock`), not from `from-name`, which can be a stale title.

### 4. Peer authentication (the part that silently breaks)

Since 2.1.266 Claude drops any inbound connection that doesn't open with the auth
line carrying **its own** `peerToken` (`Jwr`: `peerToken` → "peer", `childToken` → "child").
It never errors — the frame just vanishes. To interoperate:

1. **Derive the key-file name exactly like Claude** (`h_` → `u0` → `p0`):
   - Windows: parse the pipe (`mq`), keep `LOCAL\` if present, lower-case A–Z (`Ql`),
     prepend `\\.\pipe\` → e.g. `\\.\pipe\local\cc-msg-0123…`; then `sha256` → hex.
   - Unix: `path.resolve(sock)`; then `sha256`.
   - File: `<pid>.<hex>.key`. `canonicalSockPath` / `peerKeyFileName` implement this and
     were checked against 35/35 real key files (2.1.266 – 2.1.272).
2. **Sending** (`Kwr`): list the registry, pick files ending in `.<hex>.key` for the
   target socket, read `peerToken`; if several pids share the hash prefer a live owner.
   No key → legacy send without the auth line (older Claude builds, or peers like the
   test listeners). `sendFrame` does this automatically; pass `{ auth: false }` to
   skip, or `{ auth: "<token>" }` to force.
3. **Receiving**: publish your own key (`publishPeerKey`, 16 random bytes hex) and
   require the auth line on every connection (`bindSocket(sock, onFrame, { token })`).
   Claude reads *your* key to talk to you, so a peer without one still receives, but
   only as a legacy peer.
4. `pidDomain` (`PD()`) is optional in Claude's schema and only used to sweep stale
   `.key.tmp.*` files; we omit it.

### 5. Names, mentions and how Claude presents messages

- A message from a peer lands in Claude as a `<cross-session-message>` on the
  receiving session's **next tool round**; a `[Cross-session delivery notice]` tells
  the sender it was approved/released (Claude's `crossSessionInbound` gate: `accept`,
  `hold`, `refuse`; default = permission-mode parity between sender and receiver).
- Claude's `@session` in its editor doesn't send anything itself — it adds a hidden
  system note ("the user @-mentioned session X … use SendMessage with `to: 'X [ref]'`").
  pi does the same: `ui.addAutocompleteProvider` for the `@` popup, and a hidden
  `custom` message from `before_agent_start` (`display:false`) naming the session.
  `findMentions` only accepts names that match a **live** session, so `@src/file.ts`
  keeps meaning a file.

### 6. pi extension API surface we rely on

Types: `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
(and `pi-tui/dist/autocomplete.d.ts` for the provider).

| Hook / API | Used for |
|---|---|
| `pi.on("session_start" \| "turn_start")` | bind + register (once) |
| `pi.on("agent_end", ev.messages)` | relay the last assistant text to pending senders |
| `pi.on("session_shutdown")` | close endpoint, remove `.json` + `.key` |
| `pi.on("before_agent_start") → { message: { customType, content, display:false } }` | hidden per-turn context (the @mention note). Prefer this over `pi.on("input") → transform`, which rewrites the user's visible message |
| `pi.sendUserMessage(text, { deliverAs: "steer" })` | inject an inbound message (steer when busy) |
| `pi.registerTool` / `pi.registerCommand(name, { handler(args, ctx) })` | `claude-link` tool and `/claude-link [name …]` |
| `pi.getSessionName()` / `pi.setSessionName()` | our display name → `nameSource` |
| `ctx.ui.addAutocompleteProvider(current => provider)` | stack session names on the built-in `@` file completion; the built-in `applyCompletion` already inserts `value + " "` |
| `ctx.ui.notify`, `ctx.isIdle()`, `ctx.sessionManager.getSessionId()` | UI + state |

### 7. Windows-specific gotchas

- Node ≥ 20.12 refuses `spawn("pi.cmd")` without a shell (`EINVAL`, CVE-2024-27980).
  `test/pi-launch.mjs` finds the shim on `PATH` and runs
  `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` with `process.execPath`.
- Process start time: `powershell -NoProfile -Command "(Get-Process -Id N).StartTime.ToFileTimeUtc()"`
  (`wmic` is deprecated on Windows 11). `ps` from Git Bash doesn't support `-o lstart`.
- Use `os.tmpdir()`; `/tmp` resolves to `<drive>:\tmp`, which usually doesn't exist.
- Killing the pi window with `Stop-Process` skips `session_shutdown` → orphan registry
  files; `/exit` or `ctrl+d` in pi cleans up.

### 8. Investigating a new Claude Code build

When a Claude release changes the protocol, `claude-protocol.ts` is the only file to touch.
Techniques that worked:

- **Capture what Claude sends** with a throwaway listener: `bindSocket` on
  `peerSockPath(pid)`, `registerPeer` as e.g. `probe-listener` (no key → legacy), then
  `SendMessage` to it from Claude and log the frame *shape* (keys/types, redact tokens).
  Publish a key too to see the auth preamble.
- **Read the binary**: `grep -a -b -o 'peerToken' claude.exe` for byte offsets, then
  `dd if=claude.exe bs=1 skip=<offset-2000> count=6000 | tr -d '\0'`. A wide-context
  regex (`.{0,1500}peerToken.{0,1500}`) over the 227 MB exe takes minutes — avoid.
  Anchor strings worth searching: `cc-msg-`, `peerToken`, `.key`, `uds:`, `cross-session-message`,
  `peer_message_status`, `cc-socks`, `nameSource`.
- **Validate the hash derivation** against real files: for every `<pid>.json`, compute
  `peerKeyFileName(pid, messagingSocketPath)` and check the file exists — it must be
  100 % before trusting a canonicalization change.
- If you drive Claude Code itself for this, its **auto mode** classifier hard-blocks
  reading `.key` files and grepping the binary (and pushing a repo outside the cwd);
  switch to default mode (`Shift+Tab`) for that work.

### 9. Live test playbook (what the harnesses can't prove)

1. `npm test` (transport + auth + mentions, no pi/Claude) → `npm run test:reg` →
   `npm run test:roundtrip` (throwaway listener).
2. Start pi with the extension in a visible window (`./dev-run.sh` / `.\dev-run.ps1`),
   optionally `/claude-link name my-pi`.
3. In Claude Code: `/list-agents` shows `my-pi`; `SendMessage` → pi injects it, answers,
   relay arrives back on Claude's next tool round. Watch `<tmpdir>/pi-claude-link-debug.log`
   (sentinel `pi-claude-link-debug.on`).
4. In pi: `@link ask how are you` (or `claude-link action:ask`) → Claude replies → the
   reply lands in pi. Both directions must pass before touching a release.

### 10. Ideas / extension points

- Honor Claude's `childToken` (subagent senders) and `pidDomain`.
- `notify_when_idle`-style subscriptions and `status` updates (`updatePeer(pid, {status})`
  on `turn_start`/`agent_end`).
- A `hold` gate on the pi side mirroring `crossSessionInbound: "hold"`.
- `sid:` stable addresses once Claude ships them by default.

## More

- [SECURITY.md](./SECURITY.md) — trust model and how to report a vulnerability
- [CONTRIBUTING.md](./CONTRIBUTING.md) — layout and how to run the tests
- [CHANGELOG.md](./CHANGELOG.md) — release notes

## License

[MIT](./LICENSE)
