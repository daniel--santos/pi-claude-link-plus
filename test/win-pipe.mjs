// Transport unit test (no pi, no Claude): the platform endpoint helpers and a full
// bind -> sendFrame -> receipt round-trip over whatever this OS uses — a named pipe
// on Windows, a Unix socket elsewhere. Also exercises procStart() for this platform.
//
//   node --experimental-strip-types test/win-pipe.mjs
import assert from "node:assert/strict";
import * as P from "../claude-protocol.ts";

const isWin = process.platform === "win32";
let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}: ${e.message}`); }
};
const checkAsync = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}: ${e.message}`); }
};

// ---- isPipePath: all four spellings Claude accepts, and the negatives ----
check("isPipePath matches the pipe spellings", () => {
  for (const p of [
    String.raw`\\.\pipe\LOCAL\cc-msg-0123456789abcdef0123456789abcdef`,
    String.raw`\\?\pipe\x`, "//./pipe/x", "//?/pipe/x", String.raw`\\.\PIPE\x`,
  ]) assert.equal(P.isPipePath(p), true, p);
  for (const p of ["/tmp/cc-socks/1.sock", "/run/user/1000/cc-socks/2.sock", "", String.raw`C:\pipe\x`, "pipe/x"])
    assert.equal(P.isPipePath(p), false, p || "(empty)");
});

// ---- peerSockPath: platform-shaped endpoint ----
check("peerSockPath returns a platform-appropriate endpoint", () => {
  const p = P.peerSockPath(process.pid);
  if (isWin) {
    // Must be exactly the shape Claude Code binds itself: \\.\pipe\LOCAL\cc-msg-<32 hex>
    assert.match(p, /^\\\\\.\\pipe\\LOCAL\\cc-msg-[0-9a-f]{32}$/, p);
    assert.notEqual(p, P.peerSockPath(process.pid), "should be unique per call");
  } else {
    assert.equal(P.isPipePath(p), false);
    assert.ok(p.endsWith(`/${process.pid}.sock`), p);
    assert.ok(p.includes("cc-socks"), p);
  }
});

// ---- bindSocket + sendFrame + receipt round-trip on this OS ----
await checkAsync("bind / send / receipt round-trip", async () => {
  const sock = P.peerSockPath(process.pid);
  const got = [];
  const server = await P.bindSocket(sock, (frame) => got.push(frame));
  try {
    const content = P.buildEnvelope({ from: "uds:/nowhere", fromName: "tester", body: "hello <pipe>" });
    const id = await P.sendFrame(sock, P.buildUserFrame({ content, from: "uds:/nowhere" }));
    await P.sendFrame(sock, P.receiptFrame({ status: "delivered", origMsgId: id }));
    for (let i = 0; i < 50 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(got.length, 2, `expected 2 frames, got ${got.length}`);
    assert.equal(got[0].type, "user");
    assert.equal(P.stripEnvelope(got[0].message.content).body, "hello <pipe>");
    assert.equal(got[1].type, "control");
    assert.equal(got[1].orig_msg_id, id);
    assert.equal(await P.socketLive(sock), true, "socketLive should see the bound endpoint");
  } finally {
    server.close();
    await P.deregisterPeer(-1, sock); // -1: no registry entry; just exercises the unlink branch
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await P.socketLive(sock), false, "socketLive should be false after close");
});

// ---- peer auth: canonical path + key file name match Claude's derivation ----
check("canonicalSockPath / peerKeyFileName", () => {
  // Windows: LOCAL\ kept, everything lower-cased, both slash styles accepted
  const canon = String.raw`\\.\pipe\local\cc-msg-0123456789abcdef0123456789abcdef`;
  assert.equal(P.canonicalSockPath(String.raw`\\.\pipe\LOCAL\cc-msg-0123456789ABCDEF0123456789abcdef`), canon);
  assert.equal(P.canonicalSockPath("//./pipe/LOCAL/cc-msg-0123456789abcdef0123456789abcdef"), canon);
  assert.equal(P.canonicalSockPath(String.raw`\\.\pipe\foo`), String.raw`\\.\pipe\foo`);
  assert.equal(P.canonicalSockPath(String.raw`\\.\pipe\LOCAL\bad.`), undefined);
  assert.equal(P.canonicalSockPath("sid:abc"), undefined);
  assert.equal(P.canonicalSockPath(""), undefined);
  assert.match(P.peerKeyFileName(42, canon), /^42\.[0-9a-f]{64}\.key$/);
  assert.equal(P.peerKeyFileName(42, canon), P.peerKeyFileName(42, canon.toUpperCase().replace("PIPE", "pipe")));
  assert.match(P.newPeerToken(), /^[0-9a-f]{32}$/);
  assert.equal(P.authLine("ab"), '{"type":"auth","token":"ab"}\n');
});

// ---- peer auth: publish key -> lookup -> authenticated send; unauthenticated dropped ----
await checkAsync("publishPeerKey / lookupPeerToken / auth gate", async () => {
  const sock = P.peerSockPath(process.pid);
  const token = P.newPeerToken();
  const got = [];
  const server = await P.bindSocket(sock, (f) => got.push(f), { token });
  const keyFile = await P.publishPeerKey({ pid: process.pid, sockPath: sock, token });
  try {
    assert.ok(keyFile, "key file should be written");
    assert.equal(await P.lookupPeerToken(sock), token, "lookup must find our own key by socket hash");
    // sendFrame with no opts -> looks the token up and authenticates
    await P.sendFrame(sock, { type: "control", n: 1 });
    // explicit wrong token -> dropped by the gate
    await P.sendFrame(sock, { type: "control", n: 2 }, { auth: "0".repeat(32) }).catch(() => {});
    // no auth line at all -> dropped
    await P.sendFrame(sock, { type: "control", n: 3 }, { auth: false }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(got.map((f) => f.n), [1], `only the authenticated frame should arrive, got ${JSON.stringify(got)}`);
  } finally {
    server.close();
    await P.deregisterPeer(process.pid, sock);
  }
  assert.equal(await P.lookupPeerToken(sock), undefined, "deregisterPeer must remove the key file");
});

// ---- procStart: platform-shaped value for our own pid ----
await checkAsync("procStart returns this platform's representation", async () => {
  const v = await P.procStart(process.pid);
  assert.equal(typeof v, "string", `got ${v}`);
  if (isWin) assert.match(v, /^\d{15,}$/, `expected FILETIME digits, got "${v}"`);
  else assert.ok(v.length > 0);
});

console.log(failed ? `\n${failed} failure(s)` : "\nall passed");
process.exit(failed ? 1 : 0);
