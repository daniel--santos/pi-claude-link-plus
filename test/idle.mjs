// Unit tests for the notify_when_idle / peer_idle_notice support (no pi, no Claude).
//   node --experimental-strip-types test/idle.mjs
import assert from "node:assert/strict";
import * as P from "../claude-protocol.ts";

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}: ${e.message}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isWin = process.platform === "win32";
const sock = (n) => isWin ? String.raw`\\.\pipe\LOCAL\cc-msg-` + n.repeat(32) : `/tmp/cc-socks/${n}.sock`;
const OWN = sock("0"), A = sock("a"), B = sock("b");

/** A tracker wired to an in-memory transport. */
function harness(opts = {}) {
  const sent = [];
  let hostIdle = true;
  const subs = new P.IdleSubscriptions(
    async (to, frame) => { sent.push({ to, ...frame }); },
    { from: () => `uds:${OWN}`, ownSock: () => OWN, isIdle: () => hostIdle, debounceMs: 20, ...opts },
  );
  return { subs, sent, setHostIdle: (v) => { hostIdle = v; } };
}

await check("idleNoticeFrame / parseIdleSubscription shapes", () => {
  const f = P.idleNoticeFrame({ origMsgId: "m1", state: "idle", finishedAt: 123, from: `uds:${OWN}` });
  assert.equal(f.type, "control");
  assert.equal(f.action, "peer_idle_notice");
  assert.equal(f.orig_msg_id, "m1");
  assert.equal(f.state, "idle");
  assert.equal(f.finished_at, 123);
  assert.equal(f.from, `uds:${OWN}`);
  assert.equal(f.msgV, 1);
  assert.match(f.msg_id, /^[0-9a-f-]{36}$/);
  assert.equal("finished_at" in P.idleNoticeFrame({ origMsgId: "m", state: "exited" }), false);

  const good = { type: "control", action: "notify_when_idle", from: `uds:${A}`, msg_id: "s1", msgV: 1 };
  assert.deepEqual(P.parseIdleSubscription(good), { replyTo: A, origMsgId: "s1" });
  assert.deepEqual(P.parseIdleSubscription({ ...good, type: undefined }), { replyTo: A, origMsgId: "s1" });
  assert.equal(P.parseIdleSubscription({ ...good, type: "user" }), undefined);
  assert.equal(P.parseIdleSubscription({ ...good, msg_id: "" }), undefined);
  assert.equal(P.parseIdleSubscription({ ...good, from: A }), undefined);       // no uds: scheme
  assert.equal(P.parseIdleSubscription({ ...good, from: "uds:sid:x" }), undefined); // non-canonical
  assert.equal(P.parseIdleSubscription({ type: "control", action: "rename", name: "x" }), undefined);
  assert.deepEqual([...P.PEER_FEATURES], ["notify_idle"]);
});

await check("already idle: one notice after the debounce, no finished_at, one-shot", async () => {
  const { subs, sent } = harness();
  assert.equal(subs.subscribe(A, "s1"), "recorded");
  assert.equal(sent.length, 0, "must wait for the debounce");
  await sleep(60);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].to, sent[0].orig_msg_id, sent[0].state], [A, "s1", "idle"]);
  assert.equal("finished_at" in sent[0], false, "no turn ended yet → no finished_at");
  subs.setBusy(); subs.setIdle(); await sleep(60);
  assert.equal(sent.length, 1, "one-shot: no second notice for the same subscription");
});

await check("busy: notice when the turn ends, with finished_at", async () => {
  const { subs, sent } = harness();
  subs.setBusy();
  subs.subscribe(A, "s1");
  await sleep(60);
  assert.equal(sent.length, 0, "no notice while busy");
  const before = Date.now();
  subs.setIdle();
  await sleep(60);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].state, "idle");
  assert.ok(sent[0].finished_at >= before && sent[0].finished_at <= Date.now());
});

await check("busy again inside the debounce cancels the notice", async () => {
  const { subs, sent } = harness();
  subs.setBusy(); subs.subscribe(A, "s1");
  subs.setIdle(); subs.setBusy();   // a queued continuation started right away
  await sleep(60);
  assert.equal(sent.length, 0);
  subs.setIdle(); await sleep(60);
  assert.equal(sent.length, 1);
});

await check("host probe says busy → defer until it says idle", async () => {
  const { subs, sent, setHostIdle } = harness();
  setHostIdle(false);
  subs.subscribe(A, "s1");
  await sleep(70);
  assert.equal(sent.length, 0, "deferred while the host reports busy");
  setHostIdle(true);
  await sleep(60);
  assert.equal(sent.length, 1);
});

await check("same subscriber replaces its older subscription", async () => {
  const { subs, sent } = harness();
  subs.setBusy();
  assert.equal(subs.subscribe(A, "s1"), "recorded");
  assert.equal(subs.subscribe(A, "s2"), "refreshed");
  assert.equal(subs.subscribe(B, "s3"), "recorded");
  assert.equal(subs.size, 2);
  subs.setIdle(); await sleep(60);
  assert.deepEqual(sent.map((s) => s.orig_msg_id).sort(), ["s2", "s3"]);
});

await check("self-target and invalid addresses are ignored", () => {
  const { subs, sent } = harness();
  assert.equal(subs.subscribe(OWN, "s1"), "self");
  assert.equal(subs.subscribe("sid:abc", "s2"), "invalid");
  assert.equal(subs.size, 0);
  assert.equal(sent.length, 0);
});

await check("cap reached → \"unavailable\" to the newcomer", async () => {
  const { subs, sent } = harness({ cap: 1 });
  subs.setBusy();
  assert.equal(subs.subscribe(A, "s1"), "recorded");
  assert.equal(subs.subscribe(B, "s2"), "unavailable");
  await sleep(5);
  assert.deepEqual(sent.map((s) => [s.orig_msg_id, s.state]), [["s2", "unavailable"]]);
});

await check("exit → \"exited\" to pending subscribers, then \"unavailable\" to new ones", async () => {
  const { subs, sent } = harness();
  subs.setBusy();
  subs.subscribe(A, "s1");
  subs.subscribe(B, "s2");
  await subs.exit();
  assert.deepEqual(sent.map((s) => s.state), ["exited", "exited"]);
  assert.ok(sent.every((s) => typeof s.finished_at === "number"));
  assert.equal(subs.subscribe(A, "s3"), "unavailable");
  await sleep(5);
  assert.equal(sent.at(-1).state, "unavailable");
  await sleep(40);
  assert.equal(sent.length, 3, "no idle notice after exit");
});

await check("expired subscriptions (TTL) are dropped silently", async () => {
  const { subs, sent } = harness({ ttlMs: 10 });
  subs.setBusy();
  subs.subscribe(A, "s1");
  await sleep(30);
  subs.setIdle(); await sleep(60);
  assert.equal(sent.length, 0);
});

await check("transport errors are swallowed", async () => {
  const subs = new P.IdleSubscriptions(async () => { throw new Error("pipe gone"); },
    { from: () => `uds:${OWN}`, ownSock: () => OWN, debounceMs: 10 });
  subs.subscribe(A, "s1");
  await sleep(40);
  await subs.exit();
});

await check("registerPeer advertises peerFeatures only when given", async () => {
  const { readFile } = await import("node:fs/promises");
  const path = (await import("node:path")).default;
  const fake = 2_000_000_000 + Math.floor(Math.random() * 1000);
  const file = path.join(P.CLAUDE_REGISTRY, `${fake}.json`);
  try {
    await P.registerPeer({ pid: fake, name: "t", cwd: ".", sockPath: A });
    assert.equal("peerFeatures" in JSON.parse(await readFile(file, "utf8")), false);
    await P.registerPeer({ pid: fake, name: "t", cwd: ".", sockPath: A, peerFeatures: P.PEER_FEATURES });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).peerFeatures, ["notify_idle"]);
  } finally { await P.deregisterPeer(fake); }
});

console.log(failed ? `\n${failed} failure(s)` : "\nall passed");
process.exit(failed ? 1 : 0);
