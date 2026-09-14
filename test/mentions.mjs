// Unit tests for @mention parsing / completion helpers (pure functions, no pi, no Claude).
//   node --experimental-strip-types test/mentions.mjs
import assert from "node:assert/strict";
import { findMentions, mentionPrefix, mentionToken } from "../claude-protocol.ts";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}: ${e.message}`); }
};
const live = ["pi-001", "professor", "claude-java-client-b5", "My Session"];

check("findMentions: bare, quoted, punctuation, case, dedupe, order", () => {
  assert.deepEqual(findMentions("manda um oi para @pi-001", live), ["pi-001"]);
  assert.deepEqual(findMentions("@pi-001, tudo bem?", live), ["pi-001"]);
  assert.deepEqual(findMentions("pergunte ao @Professor?", live), ["professor"]);
  assert.deepEqual(findMentions('avise @"My Session" e @pi-001', live), ["My Session", "pi-001"]);
  assert.deepEqual(findMentions("@pi-001 e de novo @pi-001", live), ["pi-001"]);
  assert.deepEqual(findMentions("(@pi-001) [@professor]", live), ["pi-001", "professor"]);
});

check("findMentions: files, emails and unknown names are not mentions", () => {
  assert.deepEqual(findMentions("veja @src/index.ts e @README.md", live), []);
  assert.deepEqual(findMentions("mail dan@example.com", live), []);
  assert.deepEqual(findMentions("@nobody @pi-002 @pi-00", live), []);
  assert.deepEqual(findMentions("sem arroba", live), []);
  assert.deepEqual(findMentions("@pi-001", []), []);
});

check("mentionPrefix: the @token under the cursor", () => {
  assert.equal(mentionPrefix("oi @pi"), "@pi");
  assert.equal(mentionPrefix("@"), "@");
  assert.equal(mentionPrefix('diga @"My Se'), '@"My Se');
  assert.equal(mentionPrefix("oi @pi-001 "), null);
  assert.equal(mentionPrefix("dan@exa"), null);
  assert.equal(mentionPrefix("plain"), null);
});

check("mentionToken: quotes only when needed", () => {
  assert.equal(mentionToken("pi-001"), "@pi-001");
  assert.equal(mentionToken("My Session"), '@"My Session"');
  assert.equal(mentionToken('we"ird name'), '@"weird name"');
});

console.log(failed ? `\n${failed} failure(s)` : "\nall passed");
process.exit(failed ? 1 : 0);
