# Contributing

Thanks for your interest! This is a small, dependency-free pi extension.

## Layout

- `index.ts` — the extension (default-exported `ExtensionAPI` factory).
- `claude-protocol.ts` — Claude Code's cross-session wire protocol (registry, sockets,
  envelope). The single place to update if Claude's protocol changes.
- `skills/pi-claude-link/SKILL.md` — teaches the pi model to use the `claude-link` tool.
- `test/` — transport unit tests (`win-pipe.mjs`, `send-close.mjs`) and end-to-end
  harnesses driving a real pi rpc session (`reg-test.mjs`, `roundtrip.mjs`).

No build step: pi runs the TypeScript directly.

## Running the tests

`npm test` runs the transport tests and needs only Node ≥ 20.19 — no pi, no Claude.

The e2e harnesses require pi installed and a **Node ≥ 20.19** (pi crashes on older
Node). If the `pi` on your PATH runs on an older Node, point `PI_CMD` at a compatible one:

```bash
export PI_CMD="$HOME/.nvm/versions/node/v22.16.0/bin/node \
               $(npm root -g)/@earendil-works/pi-coding-agent/dist/cli.js"

npm run test:reg          # registration + cleanup
npm run test:roundtrip    # inbound relay + outbound tool
```

On Windows (PowerShell): `$env:PI_CMD = "C:\path\to\node.exe C:\path\to\pi\dist\cli.js"`.

The harnesses only use throwaway sessions/listeners — they never message your real
sessions. Set `PI_CLAUDE_LINK_DEBUG=1` (or create `<tmpdir>/pi-claude-link-debug.on`:
`/tmp` on Unix, `%TEMP%` on Windows) for logs at `<tmpdir>/pi-claude-link-debug.log`.

## Guidelines

- Keep `claude-protocol.ts` free of pi/agent imports (Node built-ins only) so it stays
  portable and testable.
- Keep platform branches (`IS_WIN` / `isPipePath`) inside `claude-protocol.ts`; the
  extension and tests should only ever see an opaque endpoint string.
- Prefer small, verifiable changes; run `npm test` and both harnesses before opening a PR.
- Be mindful of the security model (see `SECURITY.md`) — don't add paths that let
  untrusted/automated input reach an agent unprompted.

By contributing you agree your contributions are licensed under the MIT License.
