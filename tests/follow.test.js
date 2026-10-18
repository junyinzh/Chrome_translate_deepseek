import test from "node:test";
import assert from "node:assert/strict";
import {FollowNavigation, followsNavigation, pageURL} from "../lib/follow.js";

function harness() {
  let storage = {};
  const frames = new Map([[1, {documentId: "doc1", url: "https://news.example/one", frameId: 0}]]);
  const sent = [];
  let granted = true;
  const event = () => ({addListener() {}});
  const api = {
    storage: {session: {
      get: async () => structuredClone(storage),
      set: async value => { storage = {...storage, ...structuredClone(value)}; },
    }},
    permissions: {contains: async () => granted, onAdded: event(), onRemoved: event()},
    webNavigation: {getFrame: async ({tabId}) => frames.get(tabId), onCommitted: event(), onCreatedNavigationTarget: event(),
      onDOMContentLoaded: event(), onCompleted: event(), onHistoryStateUpdated: event()},
    tabs: {get: async () => ({status: "complete"}), onRemoved: event(), sendMessage: async (tabId, message, target) => {
      sent.push({tabId, message, target}); return {ok: true};
    }},
    scripting: {executeScript: async () => {}},
  };
  const settings = async () => ({hasApiKey: true, targetLanguage: "zh-Hans"});
  const service = new FollowNavigation(api, settings);
  const navigate = async (tabId, url, documentId, transitionType = "link", transitionQualifiers = []) => {
    const details = {tabId, url, documentId, transitionType, transitionQualifiers, frameId: 0};
    frames.set(tabId, details);
    await service.committed(details);
    await service.ready(details);
    return details;
  };
  return {api, service, settings, frames, sent, navigate, deny: () => { granted = false; }};
}

test("follow scope admits web links, reloads and known history while excluding typed URLs and non-web targets", () => {
  const state = {visited: ["https://news.example/one"], inherited: false};
  assert.equal(pageURL("https://news.example/one#section"), state.visited[0]);
  assert.equal(pageURL("javascript:void(0)"), null);
  assert.equal(pageURL("file:///tmp/article.html"), null);
  assert.equal(followsNavigation({url: state.visited[0], transitionType: "link"}, state), true);
  assert.equal(followsNavigation({url: state.visited[0], transitionType: "typed"}, state), false);
  assert.equal(followsNavigation({url: state.visited[0], transitionType: "reload"}, state), true);
  assert.equal(followsNavigation({url: state.visited[0], transitionType: "link", transitionQualifiers: ["from_address_bar"]}, state), false);
  assert.equal(followsNavigation({url: state.visited[0], transitionQualifiers: ["forward_back"]}, state), true);
  assert.equal(followsNavigation({url: "https://unrelated.example/", transitionQualifiers: ["forward_back"]}, state), false);
});

test("follow requires permission and never starts unrelated tabs or subframes", async () => {
  const h = harness();
  await h.service.ready({tabId: 9, frameId: 0, documentId: "unrelated", url: "https://unrelated.example/"});
  assert.equal(h.sent.length, 0);
  h.deny();
  await assert.rejects(h.service.set(1, true), /权限/);
  assert.equal((await h.service.status(1)).enabled, false);
});

test("linked navigations target exact documents once, survive worker restart, and stop on address-bar navigation", async () => {
  const h = harness();
  await h.service.set(1, true);
  const next = await h.navigate(1, "https://other.example/two", "doc2");
  await h.service.ready(next);
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[1].target, {documentId: "doc2"});
  assert.equal(h.sent[1].message.type, "PL_AUTO_START");
  const restarted = new FollowNavigation(h.api, h.settings);
  assert.equal((await restarted.status(1)).enabled, true);
  await restarted.ready(next);
  assert.equal(h.sent.length, 2);
  await h.navigate(1, "https://unrelated.example/", "doc3", "typed");
  assert.equal((await h.service.status(1)).enabled, false);
  assert.equal(h.sent.length, 2);
});

test("child tabs inherit the group; switching off removes every member and blocks delayed child events", async () => {
  const h = harness();
  await h.service.set(1, true);
  h.frames.set(2, {documentId: "doc2", url: "https://other.example/two", frameId: 0});
  await h.service.created({sourceTabId: 1, sourceFrameId: 0, tabId: 2, url: "https://other.example/two"});
  assert.equal((await h.service.status(2)).enabled, true);
  assert.equal(h.sent.at(-1).tabId, 2);
  await h.service.set(2, false);
  assert.equal((await h.service.status(1)).enabled, false);
  await h.service.created({sourceTabId: 1, sourceFrameId: 0, tabId: 3, url: "https://other.example/three"});
  assert.equal((await h.service.status(3)).enabled, false);
});

test("stale readiness events cannot start a replacement document; revocation clears follow state", async () => {
  const h = harness();
  await h.service.set(1, true);
  const replacement = {tabId: 1, documentId: "doc2", url: "https://news.example/two", transitionType: "link", frameId: 0};
  h.frames.set(1, replacement);
  await h.service.committed(replacement);
  await h.service.ready({tabId: 1, documentId: "doc1", url: "https://news.example/one", frameId: 0});
  assert.equal(h.sent.length, 1);
  h.deny();
  await h.service.ready(replacement);
  assert.equal((await h.service.status(1)).enabled, false);
  assert.equal(h.sent.filter(item => item.message.type !== "PL_PAUSE").length, 1);
  assert.equal(h.sent.at(-1).message.type, "PL_PAUSE");
});
