import test from "node:test";
import assert from "node:assert/strict";
import {buildRequest, parseTranslationResults, TranslationError} from "../lib/api.js";
import {translateResilient} from "../lib/recovery.js";
import {normalizeSettings} from "../lib/settings.js";

const settings = normalizeSettings({apiKey: "test-key"});
const blocks = [{id: "lead", parts: ["Read the ", "paper", "."]}, {id: "next", parts: ["Next paragraph."]}];
const good = group => ({translations: group.map(block => ({id: block.id, parts: block.parts.map(part => `译文${part}`)})), errors: [], usage: {total_tokens: 12}});
const bad = block => ({id: block.id, code: "INVALID_TRANSLATION", error: "Mismatched parts"});

test("numbered parts are explicit in requests and are restored in source order", () => {
  const wire = JSON.parse(buildRequest(blocks, settings).messages[1].content);
  assert.deepEqual(wire.blocks[0].parts, {0: "Read the ", 1: "paper", 2: "."});
  const result = parseTranslationResults(JSON.stringify({translations: [
    {id: "lead", parts: {2: "。", 0: "阅读", 1: "论文"}},
    {id: "next", parts: {0: "下一段。"}},
  ]}), blocks);
  assert.deepEqual(result.translations[0].parts, ["阅读", "论文", "。"]);
  assert.equal(result.errors.length, 0);
});

test("one missing, duplicate or malformed paragraph does not discard valid neighbors", () => {
  for (const invalid of [[], [{id: "lead", parts: {0: "合并"}}], [
    {id: "lead", parts: ["一", "二", "三"]}, {id: "lead", parts: ["一", "二", "三"]},
  ]]) {
    const result = parseTranslationResults(JSON.stringify({translations: [...invalid, {id: "next", parts: ["下一段"]}]}), blocks);
    assert.deepEqual(result.errors.map(item => item.id), ["lead"]);
    assert.deepEqual(result.translations, [{id: "next", parts: ["下一段"]}]);
  }
});

test("publishes good paragraphs before repairing only the missing one", async () => {
  const calls = [];
  const published = [];
  const result = await translateResilient(blocks, settings, {
    onProgress: async update => published.push(...(update.translations || []).map(item => item.id)),
    request: async group => {
      calls.push(group.map(block => block.id));
      if (calls.length === 1) return {...good([blocks[1]]), errors: [bad(blocks[0])]};
      assert.deepEqual(published, ["next"]);
      return good(group);
    },
  });
  assert.deepEqual(calls, [["lead", "next"], ["lead"]]);
  assert.deepEqual(published, ["next", "lead"]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.diagnostics.recovered, 1);
  assert.equal(result.usage.total_tokens, 24);
});

test("repeated structural failures split a complex paragraph while preserving full context", async () => {
  const complex = {id: "complex", parts: Array.from({length: 22}, (_, i) => `fragment ${i} `)};
  const calls = [];
  const result = await translateResilient([complex], settings, {request: async group => {
    calls.push(group[0]);
    if (group[0].parts.length > 8) return {translations: [], errors: [bad(group[0])]};
    assert.equal(group[0].context, complex.parts.join(""));
    return good(group);
  }});
  assert.deepEqual(calls.map(block => block.parts.length), [22, 22, 8, 8, 6]);
  assert.equal(result.translations[0].parts.length, 22);
  assert.equal(result.errors.length, 0);
  assert.equal(result.diagnostics.recovered, 1);
});

test("transient rate limits honor Retry-After and authentication errors stop immediately", async () => {
  let calls = 0;
  const delays = [];
  await translateResilient(blocks, settings, {
    request: async group => {
      if (++calls === 1) throw Object.assign(new TranslationError("rate limit", "HTTP_429", true), {retryAfterMs: 2300});
      return good(group);
    }, wait: async ms => delays.push(ms),
  });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [2300]);
  calls = 0;
  await assert.rejects(translateResilient(blocks, settings, {request: async () => {
    calls++;
    throw new TranslationError("invalid key", "HTTP_401");
  }}), error => error.code === "HTTP_401");
  assert.equal(calls, 1);
});

test("timeouts shrink requests, cancellation stops repair, and request budgets are bounded", async () => {
  let calls = 0;
  const result = await translateResilient(blocks, settings, {requestTimeoutMs: 5, request: async (group, _, {signal}) => {
    calls++;
    if (calls === 1) return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {once: true}));
    return good(group);
  }});
  assert.equal(result.errors.length, 0);
  assert.equal(result.diagnostics.errorCounts.TIMEOUT, 1);
  const controller = new AbortController();
  calls = 0;
  await assert.rejects(translateResilient(blocks, settings, {signal: controller.signal, request: async () => {
    calls++;
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  }}), error => error.name === "AbortError");
  assert.equal(calls, 1);
  calls = 0;
  const bounded = await translateResilient(blocks, settings, {maxRequests: 2, request: async group => {
    calls++;
    return {translations: [], errors: group.map(bad)};
  }});
  assert.equal(calls, 2);
  assert.equal(bounded.errors.length, 2);
  assert.equal(bounded.errors[0].code, "RETRY_LIMIT");
});
