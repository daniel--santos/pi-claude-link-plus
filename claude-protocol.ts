// Claude Code cross-session wire protocol — TypeScript port of codex-mesh/protocol.mjs.
// Lets a non-Claude process (a pi session) be a first-class peer in Claude's mesh:
// register in Claude's session registry, bind a cc-socks socket, and send/receive
// the newline-delimited JSON frames Claude uses.
//
// Node built-ins only — no pi/agent deps, so it stays portable and testable.
// Verified against Claude Code 2.1.224.

import { readdir, readFile, mkdir, chmod, unlink, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

export const HOME = homedir();
export const CLAUDE_REGISTRY = path.join(HOME, ".claude", "sessions");
export const MAX_LINE = 1024 * 1024; // Claude drops a connection past 1 MiB w/o newline
export const IS_WIN = process.platform === "win32";

/** Windows named-pipe path? Same test Claude uses (`\\.\pipe\`, `\\?\pipe\`, either slash). */
export const isPipePath = (p: string): boolean => /^[\\/]{2}[.?][\\/]pipe[\\/]/i.test(p);

export interface ClaudePeer {
  pid?: number;
  sessionId?: string;
  name: string;
  cwd: string;
  status: string;
  kind?: string;
  startedAt?: number;
  sock: string;
  live?: boolean;
}

export interface UserFrame {
  msgV: 1;
  msg_id: string;
  type: "user";
  priority: string;
  from?: string;
  session_id?: string;
  message: { role: "user"; content: string };
  [k: string]: unknown;
}

/**
 * (Unix) The directory Claude binds its own sockets in. We MUST co-locate ours there so
 * (1) Claude sends us delivery/hold receipts (it only replies to siblings of its
 * own socket), and (2) sandboxed peers (e.g. Codex's MCP server) can reach it.
 * Discovered from an existing registry entry rather than guessed from env.
 * Not meaningful on Windows (named pipes have no directory) — use peerSockPath().
 */
export function ccSocksDir(): string {
  try {
    for (const f of readdirSync(CLAUDE_REGISTRY)) {
      if (!/^\d+\.json$/.test(f)) continue;
      let s: any;
      try { s = JSON.parse(readFileSync(path.join(CLAUDE_REGISTRY, f), "utf8")); } catch { continue; }
      if (typeof s.messagingSocketPath === "string" && s.messagingSocketPath && !isPipePath(s.messagingSocketPath))
        return path.dirname(s.messagingSocketPath);
    }
  } catch { /* registry missing */ }
  const base = process.env.XDG_RUNTIME_DIR || "/tmp";
  return path.join(base, "cc-socks");
}

/**
 * The endpoint this peer should bind for the given pid.
 *  - Unix:    `<ccSocksDir()>/<pid>.sock` (a Unix domain socket next to Claude's).
 *  - Windows: `\\.\pipe\LOCAL\cc-msg-<32 hex>` — the exact shape Claude Code uses for
 *    its own pipes (verified against 2.1.270 – 2.1.272). Claude treats only this shape as a
 *    canonical peer address, so we mirror it rather than invent our own name.
 */
export function peerSockPath(pid: number): string {
  if (IS_WIN) return `\\\\.\\pipe\\LOCAL\\cc-msg-${randomBytes(16).toString("hex")}`;
  return path.join(ccSocksDir(), `${pid}.sock`);
}

// ------------------------------------------------------------------ discovery

export function socketLive(sock: string): Promise<boolean> {
  return new Promise((res) => {
    if (!sock) return res(false);
    const c = connect({ path: sock });
    const done = (v: boolean) => { c.destroy(); res(v); };
    c.setTimeout(250, () => done(false));
    c.on("connect", () => done(true));
    c.on("error", () => done(false));
  });
}

/** All live, addressable Claude peers (excludes our own socket if given). */
export async function listClaudeSessions(opts: { excludeSock?: string } = {}): Promise<ClaudePeer[]> {
  let files: string[] = [];
  try { files = await readdir(CLAUDE_REGISTRY); } catch { return []; }
  const rows: ClaudePeer[] = [];
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue;
    let s: any;
    try { s = JSON.parse(await readFile(path.join(CLAUDE_REGISTRY, f), "utf8")); } catch { continue; }
    const sock = typeof s.messagingSocketPath === "string" ? s.messagingSocketPath : "";
    if (!sock || sock === opts.excludeSock) continue;
    rows.push({
      pid: s.pid,
      sessionId: s.sessionId,
      name: typeof s.name === "string" ? s.name : `pid ${s.pid}`,
      cwd: typeof s.cwd === "string" ? s.cwd : "?",
      status: typeof s.status === "string" ? s.status : "unknown",
      kind: s.kind,
      startedAt: s.startedAt,
      sock,
    });
  }
  await Promise.all(rows.map(async (r) => { r.live = await socketLive(r.sock); }));
  return rows.filter((r) => r.live).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export interface ResolveResult { target?: ClaudePeer; error?: string; candidates?: string[]; }

/** Resolve a target by exact name, name prefix, or sessionId. */
export async function resolveTarget(nameOrId: string, opts: { excludeSock?: string } = {}): Promise<ResolveResult> {
  const rows = await listClaudeSessions(opts);
  let hit = rows.find((r) => r.sessionId === nameOrId) || rows.find((r) => r.name === nameOrId);
  if (!hit) {
    const pfx = rows.filter((r) => r.name && r.name.startsWith(nameOrId));
    if (pfx.length === 1) hit = pfx[0];
    else if (pfx.length > 1) return { error: `ambiguous: ${pfx.map((r) => r.name).join(", ")}` };
  }
  if (!hit) return { error: `no live Claude session matches "${nameOrId}"`, candidates: rows.map((r) => r.name) };
  return { target: hit };
}

// ------------------------------------------------------------------- envelope

const TAG = "cross-session-message";
const escapeBody = (b: string) => b.replace(new RegExp(`</(?=${TAG}(?:[>\\s/]|$))`, "gi"), "<\\/");
const unescapeBody = (b: string) => b.replace(new RegExp(`<\\\\/(?=${TAG}(?:[>\\s/]|$))`, "gi"), "</");

export function buildEnvelope(o: { from?: string; fromName?: string; fromMode?: string; body: string }): string {
  const attrs: string[] = [];
  if (o.from) attrs.push(`from="${o.from}"`);
  if (o.fromName) attrs.push(`from-name="${String(o.fromName).replace(/["<>]/g, "")}"`);
  if (o.fromMode) attrs.push(`from-mode="${o.fromMode}"`);
  const a = attrs.length ? " " + attrs.join(" ") : "";
  return `<${TAG}${a}>\n${escapeBody(o.body)}\n</${TAG}>`;
}

export interface StrippedEnvelope { body: string; from?: string; fromName?: string; fromMode?: string; }

/** Extract the human body + attrs from an inbound content string. Non-envelope
 *  content is returned verbatim as the body. */
export function stripEnvelope(content: unknown): StrippedEnvelope {
  if (typeof content !== "string") return { body: "" };
  const m = content.match(
    new RegExp(`^<${TAG}((?:\\s+[a-z-]+="[^"]*")*)>\\n([\\s\\S]*)\\n</${TAG}>$`)
  );
  if (!m) return { body: content };
  const attrs: Record<string, string> = {};
  for (const a of m[1].matchAll(/([a-z-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  return { body: unescapeBody(m[2]), from: attrs["from"], fromName: attrs["from-name"], fromMode: attrs["from-mode"] };
}

// ----------------------------------------------------------------- peer auth
//
// Claude Code >= 2.1.266 authenticates peers with a per-session token instead of
// trusting the socket alone (SO_PEERCRED doesn't exist for Windows named pipes):
//   - each session publishes ~/.claude/sessions/<pid>.<sha256(canonical sock)>.key
//     (mode 0600) containing { peerToken: <32 hex>, procStart | procStartFt, pidDomain? }
//   - a sender looks up the TARGET's key by hashing the target's socket path and, if
//     found, writes one auth line `{"type":"auth","token":"<peerToken>"}\n` before the
//     frame. A receiver that published a key silently drops connections that don't.
//   - no key for the target => legacy send, no auth line.
// Reverse-engineered from Claude Code 2.1.270 (functions h_/u0/p0/Kwr/J$n/Jwr); identical
// in 2.1.272 (renamed ib/eB/tB/·/Dqn/Z0r) — only minified names moved.

const TOKEN_RE = /^[0-9a-f]{32}$/;
const KEY_FILE_RE = /^(\d+)\.[0-9a-f]{64}\.key$/;
const KEY_MAX_BYTES = 4096;

export interface PeerKey { peerToken: string; procStart?: string; procStartFt?: string; pidDomain?: string; }

/** The exact string Claude hashes for a socket path — must match byte-for-byte or the
 *  key-file name differs and neither side finds the other's token.
 *   - Windows pipe: `\\.\pipe\` + the pipe name (with `LOCAL\` if present), lower-cased.
 *   - Unix: path.resolve(sock). */
export function canonicalSockPath(sock: string): string | undefined {
  const m = /^[\\/]{2}[.?][\\/]pipe[\\/](?:(LOCAL)[\\/])?([^\\/]+)$/i.exec(sock);
  if (m) {
    if (m[2] === "." || m[2] === ".." || /[. ]$/.test(m[2])) return undefined;
    const name = m[1] === undefined ? m[2] : `LOCAL\\${m[2]}`;
    return `\\\\.\\pipe\\${name.replace(/[A-Z]/g, (c) => c.toLowerCase())}`;
  }
  if (!sock || sock.startsWith("sid:")) return undefined;
  return path.resolve(sock);
}

/** `<pid>.<sha256(canonical)>.key`, or undefined for a non-canonical socket path. */
export function peerKeyFileName(pid: number, sock: string): string | undefined {
  const canon = canonicalSockPath(sock);
  if (canon === undefined) return undefined;
  return `${pid}.${createHash("sha256").update(canon).digest("hex")}.key`;
}

export const newPeerToken = (): string => randomBytes(16).toString("hex");

/** The auth preamble a sender writes before its first frame. */
export const authLine = (token: string): string => JSON.stringify({ type: "auth", token }) + "\n";

async function readPeerKey(file: string): Promise<PeerKey | undefined> {
  try {
    const raw = await readFile(file, "utf8");
    if (raw.length > KEY_MAX_BYTES) return undefined;
    const k = JSON.parse(raw);
    return typeof k?.peerToken === "string" && TOKEN_RE.test(k.peerToken) ? k : undefined;
  } catch { return undefined; }
}

const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };

/** Find the token a sender must present to the session bound at `sock` (mirrors Claude's
 *  lookup: any `*.<sha256(sock)>.key` in the registry; a live owner wins over a dead one).
 *  undefined => the target published no key; send without auth. */
export async function lookupPeerToken(sock: string): Promise<string | undefined> {
  const canon = canonicalSockPath(sock);
  if (canon === undefined) return undefined;
  const suffix = `.${createHash("sha256").update(canon).digest("hex")}.key`;
  let files: string[] = [];
  try { files = await readdir(CLAUDE_REGISTRY); } catch { return undefined; }
  let best: { alive: boolean; token: string } | undefined;
  for (const f of files) {
    if (!f.endsWith(suffix)) continue;
    const m = KEY_FILE_RE.exec(f);
    if (!m) continue;
    const k = await readPeerKey(path.join(CLAUDE_REGISTRY, f));
    if (!k) continue;
    const alive = pidAlive(parseInt(m[1], 10));
    if (!best || (alive && !best.alive)) best = { alive, token: k.peerToken };
  }
  return best?.token;
}

/** Publish our own key file so Claude authenticates to us (and so we can reject
 *  unauthenticated connections). Returns the file path, or undefined if the socket
 *  path is non-canonical (then we stay a legacy, token-less peer). */
export async function publishPeerKey(o: { pid: number; sockPath: string; token: string }): Promise<string | undefined> {
  const name = peerKeyFileName(o.pid, o.sockPath);
  if (!name) return undefined;
  await mkdir(CLAUDE_REGISTRY, { recursive: true, mode: 0o700 }).catch(() => {});
  const start = await procStart(o.pid);
  // Same field split Claude uses (y2): FILETIME goes in procStartFt on Windows.
  const body: PeerKey = { peerToken: o.token, ...(IS_WIN ? { procStartFt: start } : { procStart: start }) };
  const file = path.join(CLAUDE_REGISTRY, name);
  await unlink(file).catch(() => {});
  await writeFile(file, JSON.stringify(body), { mode: 0o600 });
  return file;
}

// ------------------------------------------------------------------ wire I/O

export function buildUserFrame(o: { content: string; from?: string; priority?: string; sessionId?: string }): UserFrame {
  return {
    msgV: 1,
    msg_id: randomUUID(),
    type: "user",
    priority: o.priority || "next",
    ...(o.from && { from: o.from }),
    ...(o.sessionId && { session_id: o.sessionId }),
    message: { role: "user", content: o.content },
  };
}

/** Send one frame to a socket path (connect, [auth line], write JSON+\n, close).
 *  `opts.auth`: token to present; omitted => looked up from the target's key file
 *  (see peer auth above); `false` => never send an auth line. */
export async function sendFrame(sock: string, frame: unknown, opts: { timeout?: number; auth?: string | false } = {}): Promise<string> {
  const timeout = opts.timeout ?? 5000;
  const token = opts.auth === false ? undefined : (opts.auth ?? await lookupPeerToken(sock));
  const payload = (token ? authLine(token) : "") + JSON.stringify(frame) + "\n";
  return new Promise((resolve, reject) => {
    const c = connect({ path: sock });
    c.setTimeout(timeout, () => { c.destroy(); reject(new Error(`timed out connecting to ${sock}`)); });
    c.on("error", reject);
    c.on("connect", () => c.end(payload, () => resolve((frame as any).msg_id)));
  });
}

/** High-level: send a message to a Claude session, wrapped as a peer would. */
export async function sendToClaude(o: { sock: string; body: string; from?: string; fromName?: string; priority?: string }): Promise<string> {
  const content = buildEnvelope({ from: o.from, fromName: o.fromName, body: o.body });
  return sendFrame(o.sock, buildUserFrame({ content, from: o.from, priority: o.priority }));
}

export function receiptFrame(o: { status: string; from?: string; origMsgId?: string | null; reason?: string }) {
  return {
    msgV: 1,
    msg_id: randomUUID(),
    type: "control",
    action: "peer_message_status",
    status: o.status,
    ...(o.reason && { reason: o.reason }),
    ...(o.from && { from: o.from }),
    ...(o.origMsgId && { orig_msg_id: o.origMsgId }),
  };
}

/** Bind a listening UDS server yielding parsed frames via onFrame(frame, socket).
 *
 *  Note: we do NOT use allowHalfOpen. Claude's sender (`d1p`) writes a frame, then
 *  half-closes and resolves its send only when the socket fully CLOSES — timing out
 *  after 5s otherwise. If we held the connection half-open, every `SendMessage` to us
 *  would be reported as "Failed to send / Timed out" even though we received it. So we
 *  let the socket close (default allowHalfOpen:false) and also end our side on `end`.
 *
 *  `opts.token`: when set (and published via publishPeerKey), every connection must open
 *  with a matching auth line or it is dropped — same rule Claude applies to us. */
export async function bindSocket(
  sockPath: string, onFrame: (frame: any, conn: Socket) => void, opts: { token?: string } = {},
): Promise<Server> {
  const pipe = isPipePath(sockPath);
  if (!pipe) {
    // Unix: the socket is a filesystem entry — make its dir private and clear stale files.
    // Named pipes have neither a directory nor a file to unlink; `LOCAL\` scopes them to
    // the current logon session, which is the equivalent of the 0o700/0o600 below.
    const dir = path.dirname(sockPath);
    await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {});
    await chmod(dir, 0o700).catch(() => {});
    await unlink(sockPath).catch(() => {});
  }
  const server = createServer((conn) => {
    conn.setEncoding("utf8");
    let buf = "";
    let authed = !opts.token; // no token published => legacy peer, accept everything
    conn.on("data", (d: string) => {
      buf += d;
      if (buf.length > MAX_LINE) { conn.destroy(); buf = ""; return; }
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let frame: any; try { frame = JSON.parse(line); } catch { continue; }
        if (!authed) {
          // First line must be the auth preamble carrying our token; anything else is dropped.
          if (frame?.type === "auth" && frame.token === opts.token) { authed = true; continue; }
          conn.destroy(); buf = ""; return;
        }
        if (frame?.type === "auth") continue; // already authed; ignore repeats
        try { onFrame(frame, conn); } catch { /* handler error */ }
      }
    });
    // When the client half-closes, close our side too so the sender's socket fully
    // closes and its send resolves (see note above).
    conn.on("end", () => { try { conn.end(); } catch { /* */ } });
    conn.on("error", () => {});
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(sockPath, () => { server.removeListener("error", rej); res(); });
  });
  if (!pipe) await chmod(sockPath, 0o600).catch(() => {});
  return server;
}

// ------------------------------------------------------------------- registry

/** Process start time, in the same representation Claude Code writes for its own
 *  `procStart` on this platform (used to detect pid reuse):
 *   - Unix:    `ps -o lstart` text, e.g. "Mon Sep 13 16:14:02 2026"
 *   - Windows: creation time as a FILETIME (100 ns ticks since 1601), e.g. "134334483310213237" */
export function procStart(pid: number): Promise<string | undefined> {
  return new Promise((res) => {
    const done = (err: Error | null, out: string) => res(err ? undefined : out.trim() || undefined);
    if (IS_WIN) {
      execFile("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${Number(pid)}).StartTime.ToFileTimeUtc()`],
        { timeout: 5000, windowsHide: true }, done);
    } else {
      execFile("ps", ["-o", "lstart=", "-p", String(pid)], done);
    }
  });
}

/** Write ~/.claude/sessions/<pid>.json so Claude lists this session as a peer. */
export async function registerPeer(o: {
  pid: number; sessionId?: string; name: string; cwd: string; sockPath: string; status?: string;
  /** "user" = a human chose the name (Claude's /list-agents shows it); "derived" = auto (shown
   *  as "(unnamed session)" to humans, still addressable by the model). */
  nameSource?: "user" | "derived";
}): Promise<void> {
  await mkdir(CLAUDE_REGISTRY, { recursive: true }).catch(() => {});
  const entry = {
    pid: o.pid,
    sessionId: o.sessionId || randomUUID(),
    cwd: o.cwd || process.cwd(),
    startedAt: Date.now(),
    procStart: await procStart(o.pid),
    version: "pi-claude-link",
    peerProtocol: 1,
    kind: "interactive",
    entrypoint: "pi",
    messagingSocketPath: o.sockPath,
    name: o.name,
    nameSource: o.nameSource || "derived",
    status: o.status || "idle",
  };
  await writeFile(path.join(CLAUDE_REGISTRY, `${o.pid}.json`), JSON.stringify(entry, null, 2));
}

export async function updatePeer(pid: number, patch: Record<string, unknown>): Promise<void> {
  const f = path.join(CLAUDE_REGISTRY, `${pid}.json`);
  let cur: any = {};
  try { cur = JSON.parse(await readFile(f, "utf8")); } catch { return; }
  await writeFile(f, JSON.stringify({ ...cur, ...patch }, null, 2));
}

export async function deregisterPeer(pid: number, sockPath?: string): Promise<void> {
  await unlink(path.join(CLAUDE_REGISTRY, `${pid}.json`)).catch(() => {});
  if (!sockPath) return;
  const key = peerKeyFileName(pid, sockPath);
  if (key) await unlink(path.join(CLAUDE_REGISTRY, key)).catch(() => {});
  // Named pipes vanish when the server closes; only Unix sockets leave a file behind.
  if (!isPipePath(sockPath)) await unlink(sockPath).catch(() => {});
}

/** The display name Claude's /list-agents shows for the session bound to `sock`,
 *  looked up from the registry so it always matches the list (envelope from-name
 *  can be a stale title). Returns undefined if no registry entry matches. */
export function peerNameBySock(sock: string): string | undefined {
  if (!sock) return undefined;
  try {
    for (const f of readdirSync(CLAUDE_REGISTRY)) {
      if (!/^\d+\.json$/.test(f)) continue;
      let s: any;
      try { s = JSON.parse(readFileSync(path.join(CLAUDE_REGISTRY, f), "utf8")); } catch { continue; }
      if (s.messagingSocketPath === sock && typeof s.name === "string") return s.name;
    }
  } catch { /* registry missing */ }
  return undefined;
}

// ------------------------------------------------------------------- mentions

/** Session names @-mentioned in `text`, resolved against `names` (the live sessions).
 *  A mention is `@name` or `@"name with spaces"` at a token boundary; only names that
 *  exactly match (then case-insensitively) a live session count, so `@src/file.ts`
 *  keeps meaning a file. Returns the matched live names, deduplicated, in order. */
export function findMentions(text: string, names: string[]): string[] {
  const out: string[] = [];
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const re = /(^|[\s(\[{,;:])@(?:"([^"\n]+)"|([^\s@"]+))/g;
  for (const m of text.matchAll(re)) {
    const raw = (m[2] ?? m[3] ?? "").trim();
    if (!raw) continue;
    // allow trailing punctuation on the bare form: "@pi-001," / "@pi-001?"
    const candidates = m[2] !== undefined ? [raw] : [raw, raw.replace(/[.,;:!?)\]}]+$/, "")];
    for (const c of candidates) {
      const hit = names.includes(c) ? c : byLower.get(c.toLowerCase());
      if (hit) { if (!out.includes(hit)) out.push(hit); break; }
    }
  }
  return out;
}

/** The `@…` token to complete: text after the last whitespace if it starts with `@`. */
export function mentionPrefix(textBeforeCursor: string): string | null {
  const m = /(?:^|\s)(@(?:"[^"\n]*|[^\s@"]*))$/.exec(textBeforeCursor);
  return m ? m[1] : null;
}

/** How a name must be written after `@` to survive tokenization. */
export const mentionToken = (name: string): string => /[\s"]/.test(name) ? `@"${name.replace(/"/g, "")}"` : `@${name}`;

export function slugFromCwd(cwd: string): string {
  const base = path.basename(cwd || "pi") || "pi";
  return base.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 32);
}
