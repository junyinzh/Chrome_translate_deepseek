import assert from "node:assert/strict";
import {chromium} from "playwright";
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {loadTestSettings} from "./test-config.mjs";

// Optional live regression: external Wikipedia access and API credits required.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const settings = await loadTestSettings();
if (!settings.apiKey) throw new Error("Configure DEEPSEEK_API_KEY or local-config.json before this live test.");
const temporary = await mkdtemp(join(tmpdir(), "pagelingo-wikipedia-"));
const extension = join(temporary, "extension");
const output = join(root, "test-results");
await mkdir(output, {recursive: true});
let context;
try {
  await cp(root, extension, {recursive: true, filter: source => ![".git", "local-config.json", "node_modules", "test-results", ".browser-profile"].includes(basename(source))});
  const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
  manifest.host_permissions.push("https://en.wikipedia.org/*");
  await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(join(temporary, "profile"), {
    channel: "chromium", headless: true, viewport: {width: 1600, height: 1000},
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  const saved = await options.evaluate(settings => chrome.runtime.sendMessage({type: "PL_SAVE_SETTINGS", settings}), {...settings, scope: "viewport", dynamic: false});
  assert.equal(saved.ok, true);
  await worker.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.__requests = [];
    globalThis.fetch = async (url, init) => {
      if (url === "https://api.deepseek.com/chat/completions") {
        const {blocks} = JSON.parse(JSON.parse(init.body).messages[1].content);
        globalThis.__requests.push(blocks.map(block => ({id: block.id, text: Object.values(block.parts).join(""), parts: Object.keys(block.parts).length})));
      }
      return original(url, init);
    };
  });
  const page = await context.newPage();
  const url = "https://en.wikipedia.org/wiki/St._Moritz";
  await page.goto(url, {waitUntil: "domcontentloaded", timeout: 45000});
  await page.locator("#mw-content-text").waitFor();
  await page.waitForTimeout(1000);
  const original = await page.evaluate(() => {
    window.__lead = [...document.querySelectorAll("#mw-content-text p")].find(p => p.textContent.includes("is a municipality and a high"));
    if (!window.__lead) throw new Error("Wikipedia changed its lead; update the live test selector.");
    window.__firstLink = window.__lead.querySelector("a");
    return window.__lead.innerHTML;
  });
  const tabId = await options.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, url);
  await options.evaluate(tabId => chrome.scripting.executeScript({target: {tabId}, files: ["content.js"]}), tabId);
  await page.evaluate(() => {
    window.__started = performance.now();
    window.__leadObserver = new MutationObserver(() => {
      if (/\p{Script=Han}/u.test(window.__lead.textContent)) {
        window.__firstLeadMs ??= Math.round(performance.now() - window.__started);
      }
    });
    window.__leadObserver.observe(window.__lead, {subtree: true, characterData: true});
  });
  await options.evaluate(({tabId, settings}) => chrome.tabs.sendMessage(tabId, {type: "PL_START", settings}), {tabId, settings: saved.settings});
  const deadline = Date.now() + 180000;
  let status;
  while (Date.now() < deadline) {
    status = await options.evaluate(async tabId => (await chrome.tabs.sendMessage(tabId, {type: "PL_PAGE_STATUS"})).status, tabId);
    if (["complete", "error"].includes(status.state)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(status.state, "complete", JSON.stringify(status));
  assert.equal(status.failed, 0);
  const requests = await worker.evaluate(() => globalThis.__requests);
  assert.equal(requests[0][0].text, "St. Moritz");
  assert.match(requests[0][1].text, /is a municipality and a high/);
  const pageResult = await page.evaluate(() => ({
    firstLeadMs: window.__firstLeadMs, elapsedMs: Math.round(performance.now() - window.__started),
    lead: window.__lead.textContent, sameLink: window.__firstLink === window.__lead.querySelector("a"),
  }));
  assert.ok(pageResult.firstLeadMs > 0);
  assert.equal(pageResult.sameLink, true);
  await page.screenshot({path: join(output, "wikipedia-v020.png")});
  await options.evaluate(tabId => chrome.tabs.sendMessage(tabId, {type: "PL_RESTORE"}), tabId);
  assert.equal(await page.evaluate(() => window.__lead.innerHTML), original);
  const report = {testedAt: new Date().toISOString(), version: manifest.version, url, scope: "viewport", model: settings.model,
    ...pageResult, status, providerCalls: requests.length, firstRequest: requests[0], restoredExactly: true};
  await writeFile(join(output, "wikipedia-live-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({version: report.version, firstLeadMs: report.firstLeadMs, elapsedMs: report.elapsedMs,
    translated: status.translated, failed: status.failed, recovered: status.recovered, providerCalls: report.providerCalls, restoredExactly: true}, null, 2));
} finally {
  await context?.close();
  await rm(temporary, {recursive: true, force: true});
}
