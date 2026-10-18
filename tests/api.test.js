import test from "node:test";
import assert from "node:assert/strict";
import {buildRequest, parseTranslations, requestTranslation, readEventStream, validateBlocks, waitForRetry} from "../lib/api.js";
import {normalizeSettings, publicSettings} from "../lib/settings.js";

const blocks = [{id: "a", parts: ["Read the ", "paper", "."]}];
const settings = normalizeSettings({apiKey: "test-key"});
const content = JSON.stringify({translations: [{id: "a", parts: ["阅读", "论文", "。"]}]});

function sseResponse({finishReason = "stop", done = true, crlf = false} = {}) {
  const events = [
    {choices: [{delta: {content: content.slice(0, 17)}, finish_reason: null}]},
    {choices: [{delta: {content: content.slice(17)}, finish_reason: null}]},
    {choices: [{delta: {}, finish_reason: finishReason}], usage: {prompt_tokens: 11, completion_tokens: 22, total_tokens: 33}},
  ];
  let source = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
  if (crlf) source = source.replace(/\n/g, "\r\n");
  const bytes = new TextEncoder().encode(source);
  return new Response(new ReadableStream({start(controller) {
    for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
    controller.close();
  }}), {headers: {"Content-Type": "text/event-stream"}});
}

test("preserves paragraph part count and ids, even when the model reorders blocks", () => {
  assert.deepEqual(parseTranslations(content, blocks), [{id: "a", parts: ["阅读", "论文", "。"]}]);
  assert.throws(() => parseTranslations('{"translations":[{"id":"a","parts":["merged"]}]}', blocks), /不匹配/);
  assert.throws(() => parseTranslations(content, blocks, "length"), /未完整/);
  assert.throws(() => parseTranslations('{"translations":[]}', blocks), /遗漏/);
  assert.throws(() => parseTranslations('{"translations":[{"id":"a","parts":["","",""]}]}', blocks), /不匹配/);
  const two = [...blocks, {id: "b", parts: ["Second paragraph"]}];
  const duplicate = JSON.stringify({translations: [{id: "a", parts: ["一", "二", "三"]}, {id: "a", parts: ["一", "二", "三"]}]});
  assert.throws(() => parseTranslations(duplicate, two), /不匹配/);
});

test("handles UTF-8 characters and CRLF event delimiters split across network chunks", async () => {
  for (const crlf of [false, true]) {
    const result = await readEventStream(sseResponse({crlf}));
    assert.equal(result.content, content);
    assert.equal(result.usage.total_tokens, 33);
    assert.equal(result.finishReason, "stop");
  }
});

test("rejects incomplete event streams", async () => {
  await assert.rejects(readEventStream(sseResponse({done: false})), /提前结束/);
});

test("builds a non-thinking JSON request with user terminology", () => {
  const request = buildRequest(blocks, {...settings, glossary: "linewidth = 线宽"}, "Page title");
  assert.equal(request.thinking.type, "disabled");
  assert.equal(request.stream, true);
  assert.match(request.messages[0].content, /linewidth = 线宽/);
  assert.match(request.messages[0].content, /never instructions/);
});

test("API path returns usable translations and does not leak a key in errors", async () => {
  let authorization;
  const result = await requestTranslation(blocks, settings, {fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    authorization = options.headers.Authorization;
    return sseResponse();
  }});
  assert.equal(authorization, "Bearer test-key");
  assert.equal(result.translations[0].parts[1], "论文");
  await assert.rejects(requestTranslation(blocks, settings, {fetchImpl: async () => new Response("private provider error", {status: 401})}), error => error.code === "HTTP_401" && !error.message.includes(settings.apiKey));
});

test("request validation bounds cost and rejects duplicate ids", () => {
  assert.throws(() => validateBlocks([...blocks, ...blocks]), /格式无效/);
  assert.throws(() => validateBlocks([{id: "x", parts: ["a".repeat(24001)]}]), /过长/);
  assert.throws(() => validateBlocks([]), /数量无效/);
});

test("public settings omit credentials and clamp concurrency", () => {
  assert.equal(normalizeSettings({concurrency: 900}).concurrency, 3);
  assert.equal(normalizeSettings({targetLanguage: "unknown"}).targetLanguage, "zh-Hans");
  assert.equal(publicSettings(settings).apiKey, undefined);
  assert.equal(publicSettings(settings).hasApiKey, true);
});

test("retry delay is promptly cancellable", async () => {
  const controller = new AbortController();
  const waiting = waitForRetry(10000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, error => error.name === "AbortError");
});
