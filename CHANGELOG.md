# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Peer authentication (Claude Code ≥ 2.1.266).** Claude now drops frames from peers
  that don't present its per-session token. pi publishes its own
  `~/.claude/sessions/<pid>.<sha256(socket)>.key`, verifies the `{"type":"auth"}`
  preamble on inbound connections, and `sendFrame` looks up the target's key and sends
  the preamble automatically (legacy token-less send when the target has no key).
  `/claude-link name <name>` names the pi session as Claude sees it (registered as
  `nameSource:"user"`, which Claude's `/list-agents` UI requires to show a name).
  New in `claude-protocol.ts`: `canonicalSockPath`, `peerKeyFileName`, `newPeerToken`,
  `authLine`, `lookupPeerToken`, `publishPeerKey`; `bindSocket(..., { token })`;
  `sendFrame(..., { auth })`; `deregisterPeer` also removes the key file.
- **Windows 11 support.** On Windows the peer endpoint is a named pipe in the same
  `\\.\pipe\LOCAL\cc-msg-<32 hex>` shape Claude Code binds itself (`peerSockPath()`),
  and `procStart` is written as a FILETIME via `Get-Process`, matching Claude's own
  registry entries. Verified against Claude Code 2.1.270.
- `npm test` — transport unit tests (`test/win-pipe.mjs`) that need neither pi nor
  Claude; `test:reg` / `test:roundtrip` scripts for the e2e harnesses.
- `dev-run.ps1` for PowerShell.

### Changed
- `isPipePath()` / `IS_WIN` in `claude-protocol.ts`; `bindSocket` and `deregisterPeer`
  skip `mkdir`/`chmod`/`unlink` for named pipes.
- Socket-dir discovery no longer requires a `.sock` suffix (it excludes pipe paths instead).
- Debug sentinel/log moved from hard-coded `/tmp` to `os.tmpdir()` (still `/tmp` on Unix).
- Test harnesses use portable paths; on Windows they launch pi's `cli.js` directly
  (Node refuses to spawn the `pi.cmd` shim without a shell).

## [0.1.0] - 2026-08-08

Initial release.

### Added
- Pi sessions auto-register as peers in Claude Code's registry and appear in
  `/list-agents` (on `session_start`; cleaned up on `session_shutdown`).
- Real-time inbound: messages from Claude are injected into the live pi session via
  `pi.sendUserMessage` (idle → new turn; busy → steer), with delivery receipts.
- Reply relay: pi's answer is sent back to the originating Claude session on `agent_end`.
- Model-facing `claude-link` tool with `list` / `send` / `ask` (blocking) actions,
  a `/claude-link` command, and a bundled skill.
- Sender display names resolved from Claude's registry to match `/list-agents`.
- Dependency-free `claude-protocol.ts` port of Claude's cross-session wire protocol.

[0.1.0]: https://github.com/alonw0/pi-claude-link/releases/tag/v0.1.0
