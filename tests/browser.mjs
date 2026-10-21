import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile, writeFile, mkdir, mkdtemp, cp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, dirname, basename} from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import {loadTestSettings} from "../scripts/test-config.mjs";

let playwright;
try { playwright = await import("playwright"); }
catch {
  const bundled = process.env.PAGELINGO_NODE_MODULES;
  if (!bundled) throw new Error("Run npm ci and npx playwright install chromium before browser tests.");
  playwright = createRequire(join(bundled, "package.json"))("playwright");
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const live = process.argv.includes("--live");
const localSettings = await loadTestSettings();
if (live && !localSettings.apiKey) throw new Error("Set DEEPSEEK_API_KEY or create an ignored local-config.json before live browser tests.");
const apiKey = live ? localSettings.apiKey : "mock-api-key";
const output = join(root, "test-results");
await mkdir(output, {recursive: true});
const temporary = await mkdtemp(join(tmpdir(), "pagelingo-test-"));
const extensionPath = join(temporary, "extension");
await cp(root, extensionPath, {recursive: true, filter: source => ![".git", "local-config.json", "node_modules", "test-results", ".browser-profile"].includes(basename(source))});
const manifest = JSON.parse(await readFile(join(extensionPath, "manifest.json"), "utf8"));
manifest.host_permissions.push("http://127.0.0.1/*");
await writeFile(join(extensionPath, "manifest.json"), JSON.stringify(manifest));
const fixture = await readFile(join(root, "tests/fixture.html"));
const wikiFixture = await readFile(join(root, "tests/wiki-fixture.html"));
const server = createServer((request, response) => { response.writeHead(200, {"content-type": "text/html; charset=utf-8"}); response.end(request.url === "/wiki" ? wikiFixture : fixture); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/fixture`;
const checks = [];
let context;
const check = name => { checks.push(name); console.log(`PASS ${name}`); };

try {
  context = await playwright.chromium.launchPersistentContext(join(temporary, "profile"), {
    channel: "chromium", headless: true, viewport: {width: 1280, height: 1000},
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).host;
  const options = await context.newPage();
  const browserErrors = [];
  options.on("pageerror", error => browserErrors.push(error.message));
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.waitForFunction(() => !document.querySelector("#key-hint").textContent.includes("正在"));
  assert.equal(await options.locator("#api-key").inputValue(), "");
  assert.equal(await options.locator("#concurrency").inputValue(), "12");
  assert.deepEqual(await options.locator("#concurrency option").evaluateAll(options => options.map(option => Number(option.value))),
    Array.from({length: 12}, (_, index) => index + 1));
  await options.locator("#api-key").fill(apiKey);
  await options.locator("#save").click();
  await options.waitForFunction(() => document.querySelector("#message").textContent.startsWith("设置已保存"));
  assert.equal(await options.locator("#api-key").getAttribute("type"), "password");
  await options.screenshot({path: join(output, "settings.png"), fullPage: true});
  check("public installation starts without a key and accepts user configuration");
  const publicSettings = await options.evaluate(() => chrome.runtime.sendMessage({type: "PL_PUBLIC_SETTINGS"}));
  assert.equal(publicSettings.ok, true);
  assert.equal(publicSettings.settings.apiKey, undefined);
  assert.equal(publicSettings.settings.concurrency, 12);

  await worker.evaluate(() => {
    globalThis.__originalFetch = globalThis.fetch;
    globalThis.__testMode = "normal";
    globalThis.__apiCalls = [];
    globalThis.fetch = async (url, init) => {
      if (url !== "https://api.deepseek.com/chat/completions") return globalThis.__originalFetch(url, init);
      const request = JSON.parse(init.body);
      const input = JSON.parse(request.messages[1].content);
      const blocks = input.blocks.map(block => ({...block, parts: Object.values(block.parts)}));
      globalThis.__apiCalls.push(blocks);
      if (globalThis.__testMode === "unauthorized") return new Response("Unauthorized", {status: 401});
      if (globalThis.__testMode === "slow") await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1800);
        init.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, {once: true});
      });
      if (globalThis.__testMode === "wiki-repair" && blocks.length === 1 && blocks[0].parts.length > 8) await new Promise(resolve => setTimeout(resolve, 650));
      const translations = blocks.map(block => {
        let parts = block.parts.map(part => `译文：${part.trim()}`);
        if (globalThis.__testMode === "compact") parts = block.parts.map(() => "译文");
        if (globalThis.__testMode === "wiki-repair" && parts.length > 8) parts = parts.slice(0, -1);
        if (globalThis.__testMode === "wiki-fail" && block.parts.join("").includes("southern slopes")) parts = [];
        return {id: block.id, parts};
      });
      return new Response(JSON.stringify({choices: [{finish_reason: "stop", message: {content: JSON.stringify({translations})}}], usage: {prompt_tokens: 100, completion_tokens: 50, total_tokens: 150}}), {headers: {"Content-Type": "application/json"}});
    };
  });

  const page = await context.newPage();
  page.on("pageerror", error => browserErrors.push(error.message));
  await page.goto(url);
  const original = await page.locator("body").innerHTML();
  const originalFormula = await page.locator("#formula").evaluate(element => element.outerHTML);
  await page.evaluate(() => {
    window.savedLink = document.querySelector("#paper-link");
    window.linkClicks = 0;
    window.savedLink.addEventListener("click", event => { event.preventDefault(); window.linkClicks++; });
  });
  const tabId = await options.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, url);
  const popup = await context.newPage();
  popup.on("pageerror", error => browserErrors.push(error.message));
  await popup.addInitScript(({tabId, url}) => { chrome.tabs.query = async () => [{id: tabId, url}]; }, {tabId, url});
  await popup.setViewportSize({width: 364, height: 580});
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.locator("#translate").waitFor({state: "visible"});
  await popup.waitForFunction(() => !document.querySelector("#translate").disabled);
  await popup.screenshot({path: join(output, "popup.png"), fullPage: true});

  async function status() {
    return options.evaluate(async tabId => (await chrome.tabs.sendMessage(tabId, {type: "PL_PAGE_STATUS"})).status, tabId);
  }
  async function waitState(states) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try {
        const current = await status();
        if (states.includes(current.state)) return current;
      } catch { /* Content scripts may still be starting. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${states.join("/")}`);
  }
  async function waitComplete() {
    const current = await waitState(["complete", "error"]);
    assert.equal(current.state, "complete", JSON.stringify(current));
  }
  async function restore() {
    await options.evaluate(tabId => chrome.tabs.sendMessage(tabId, {type: "PL_RESTORE"}), tabId);
    await popup.waitForFunction(() => document.querySelector("#translate").textContent === "翻译网页");
  }
  async function clearCache() {
    const result = await options.evaluate(() => chrome.runtime.sendMessage({type: "PL_CLEAR_CACHE"}));
    assert.equal(result.ok, true);
  }

  await popup.locator("#translate").click();
  await waitComplete();
  assert.match(await page.locator("#heading").textContent(), /译文/);
  assert.equal(await page.evaluate(() => window.savedLink === document.querySelector("#paper-link")), true);
  assert.equal(await page.locator("#paper-link").getAttribute("href"), "https://example.com/paper");
  await page.locator("#paper-link").click();
  assert.equal(await page.evaluate(() => window.linkClicks), 1);
  assert.equal(await page.locator("#formula").evaluate(element => element.outerHTML), originalFormula);
  assert.equal(await page.locator("#inline-code").textContent(), "npm install example");
  assert.equal(await page.locator("#editable").textContent(), "Editable text must remain untouched.");
  assert.equal(await page.locator("#protected").textContent(), "This paragraph must remain untouched.");
  assert.equal(await page.locator("#user-input").inputValue(), "Do not translate my input");
  const sent = await worker.evaluate(() => JSON.stringify(globalThis.__apiCalls));
  assert.equal(sent.includes("Hidden content must not"), false);
  assert.equal(sent.includes("Editable text must"), false);
  check("in-place translation preserves links, listeners, emphasis, math, code and editing areas");

  await restore();
  assert.equal(await page.locator("body").innerHTML(), original);
  check("restore returns the exact original body markup");
  const beforeCache = await worker.evaluate(() => globalThis.__apiCalls.length);
  await popup.locator("#translate").click();
  await waitComplete();
  assert.equal(await worker.evaluate(() => globalThis.__apiCalls.length), beforeCache);
  assert.ok((await status()).cacheHits > 0);
  check("repeated translation uses the persistent cache without API requests");

  await page.evaluate(() => {
    const element = document.createElement("p");
    element.id = "added-paragraph";
    element.textContent = "New content appears after the initial page has loaded.";
    document.querySelector("#dynamic-zone").append(element);
  });
  await page.waitForFunction(() => document.querySelector("#added-paragraph").textContent.includes("译文"));
  await page.evaluate(() => { document.querySelector("#science").textContent = "The website updated this paragraph while translation was enabled."; });
  await page.waitForFunction(() => document.querySelector("#science").textContent.includes("译文"));
  await waitComplete();
  await restore();
  assert.equal(await page.locator("#science").textContent(), "The website updated this paragraph while translation was enabled.");
  assert.equal(await page.locator("#added-paragraph").textContent(), "New content appears after the initial page has loaded.");
  check("dynamic additions and site updates are translated and restored correctly");

  const longText = "This extended paragraph tests stable text-node slices. ".repeat(190);
  await page.evaluate(text => {
    const element = document.createElement("p");
    element.id = "long-paragraph";
    element.textContent = text;
    document.querySelector("#dynamic-zone").append(element);
    window.longTextNode = element.firstChild;
  }, longText);
  await popup.locator("#translate").click();
  await waitComplete();
  assert.match(await page.locator("#long-paragraph").textContent(), /译文/);
  assert.equal(await page.evaluate(() => window.longTextNode === document.querySelector("#long-paragraph").firstChild), true);
  await restore();
  assert.equal(await page.locator("#long-paragraph").textContent(), longText);
  check("long text nodes split across concurrent batches retain identity and restore exactly");

  await clearCache();
  await worker.evaluate(() => { globalThis.__testMode = "slow"; });
  await popup.locator("#translate").click();
  await waitState(["translating"]);
  await options.evaluate(tabId => chrome.tabs.sendMessage(tabId, {type: "PL_PAUSE"}), tabId);
  const pausedText = await page.locator("#heading").textContent();
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.equal(await page.locator("#heading").textContent(), pausedText);
  assert.equal((await status()).state, "paused");
  await worker.evaluate(() => { globalThis.__testMode = "normal"; });
  await popup.waitForFunction(() => document.querySelector("#translate").textContent === "继续翻译");
  await popup.locator("#translate").click();
  await waitComplete();
  check("pause cancels pending work and resume completes it");

  await restore();
  await clearCache();
  await worker.evaluate(() => { globalThis.__testMode = "unauthorized"; });
  await popup.locator("#translate").click();
  await waitState(["error"]);
  assert.match((await status()).error, /API Key/);
  assert.equal((await status()).active, false);
  check("authentication failure stops work and shows an actionable error");
  await restore();

  await worker.evaluate(() => { globalThis.__testMode = "normal"; });
  await popup.locator("#scope").selectOption("viewport");
  await page.evaluate(() => window.scrollTo(0, 0));
  await popup.locator("#translate").click();
  await waitComplete();
  assert.equal(await page.locator("#below-fold").textContent(), "This paragraph is below the fold and explains the final experimental result.");
  await page.locator("#below-fold").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector("#below-fold").textContent.includes("译文"));
  await waitComplete();
  check("viewport mode translates additional content when scrolling");
  await restore();

  await page.goto(new URL("/wiki", url).href);
  const wikiOriginal = await page.locator("body").innerHTML();
  const citation = await page.locator(".reference").innerHTML();
  await popup.reload();
  await popup.waitForFunction(() => !document.querySelector("#translate").disabled);
  await popup.locator("#scope").selectOption("page");
  await clearCache();
  await worker.evaluate(() => { globalThis.__testMode = "wiki-repair"; globalThis.__apiCalls = []; });
  await popup.locator("#translate").click();
  await page.waitForFunction(() => document.querySelector("#wiki-title").textContent.includes("译文"));
  assert.equal((await page.locator("#wiki-lead").textContent()).includes("译文"), false);
  const firstCalls = await worker.evaluate(() => globalThis.__apiCalls);
  assert.equal(firstCalls[0].length, 2);
  assert.equal(firstCalls[0][0].parts.join(""), "Riverton");
  assert.match(firstCalls[0][1].parts.join(""), /is a small town/);
  assert.equal(firstCalls[0][1].parts.join("").includes("[a]"), false);
  check("encyclopedia title and lead are the first small batch, ahead of navigation and sidebars");
  await waitComplete();
  assert.equal((await status()).failed, 0);
  assert.equal((await status()).recovered, 1);
  assert.match(await page.locator("#wiki-lead").textContent(), /译文/);
  assert.equal(await page.locator(".reference").innerHTML(), citation);
  const repairCalls = await worker.evaluate(() => globalThis.__apiCalls);
  assert.equal(repairCalls.flat().filter(block => block.parts.join("") === "Riverton").length, 1);
  assert.ok(repairCalls.flat().some(block => block.context && block.parts.length <= 8));
  check("valid neighbors appear during repair; only the complex lead is retried in smaller pieces");
  await restore();
  assert.equal(await page.locator("body").innerHTML(), wikiOriginal);
  check("encyclopedia links, footnotes and body markup restore exactly after recovery");

  // Warm the cache with the lead hidden, then reveal it for a mixed cached/live batch.
  await clearCache();
  await page.evaluate(() => { document.querySelector("#wiki-lead").hidden = true; document.querySelector("#wiki-second").hidden = true; });
  await worker.evaluate(() => { globalThis.__testMode = "normal"; });
  await popup.locator("#translate").click();
  await waitComplete();
  await restore();
  await page.evaluate(() => { document.querySelector("#wiki-lead").hidden = false; document.querySelector("#wiki-second").hidden = false; });
  await worker.evaluate(() => { globalThis.__testMode = "slow"; globalThis.__apiCalls = []; });
  await popup.locator("#translate").click();
  await page.waitForFunction(() => document.querySelector("#wiki-title").textContent.includes("译文"));
  assert.equal((await page.locator("#wiki-lead").textContent()).includes("译文"), false);
  await options.evaluate(tabId => chrome.tabs.sendMessage(tabId, {type: "PL_PAUSE"}), tabId);
  await worker.evaluate(() => { globalThis.__testMode = "normal"; });
  await popup.waitForFunction(() => document.querySelector("#translate").textContent === "继续翻译");
  await popup.locator("#translate").click();
  await waitComplete();
  const resumed = await status();
  assert.equal(resumed.processed, resumed.total);
  assert.equal(resumed.translated, resumed.total);
  assert.equal((await page.locator("#wiki-title").textContent()).match(/译文/g).length, 1);
  check("cached text appears before network completion and partial-progress pause/resume counts each unit once");
  await restore();

  await clearCache();
  await worker.evaluate(() => { globalThis.__testMode = "wiki-fail"; });
  await popup.locator("#translate").click();
  await waitState(["error"]);
  assert.equal((await status()).failed, 1);
  assert.match(await page.locator("#wiki-lead").textContent(), /译文/);
  assert.equal((await page.locator("#wiki-second").textContent()).includes("译文"), false);
  await worker.evaluate(() => { globalThis.__testMode = "normal"; globalThis.__apiCalls = []; });
  await popup.waitForFunction(() => document.querySelector("#translate").textContent === "重试失败段落");
  await popup.locator("#translate").click();
  await waitComplete();
  assert.equal((await worker.evaluate(() => globalThis.__apiCalls)).flat().length, 1);
  assert.equal((await status()).processed, (await status()).total);
  check("permanent paragraph failure does not discard its neighbors and manual retry sends only that paragraph");
  await restore();

  await clearCache();
  await worker.evaluate(() => { globalThis.__testMode = "slow"; globalThis.__apiCalls = []; });
  await popup.locator("#translate").click();
  await waitState(["translating"]);
  await page.locator("#wiki-bottom").scrollIntoViewIfNeeded();
  await worker.evaluate(() => { globalThis.__testMode = "normal"; });
  await waitComplete();
  const scrollCalls = await worker.evaluate(() => globalThis.__apiCalls);
  assert.match(scrollCalls[1].map(block => block.parts.join("")).join(""), /Later sections describe/);
  check("whole-page mode reprioritizes queued body text after scrolling");
  await restore();

  await page.goto(url);
  await page.evaluate(() => {
    document.body.innerHTML = `<main style="width:350px"><h1>Reflow test</h1><p>${"A paragraph with many words. ".repeat(150)}</p><p id="revealed">Newly visible after the paragraph above shrinks.</p></main>`;
  });
  assert.ok(await page.locator("#revealed").evaluate(element => element.getBoundingClientRect().top > innerHeight));
  await popup.reload();
  await popup.waitForFunction(() => !document.querySelector("#translate").disabled);
  await popup.locator("#scope").selectOption("viewport");
  await clearCache();
  await worker.evaluate(() => { globalThis.__testMode = "compact"; });
  await popup.locator("#translate").click();
  await waitComplete();
  assert.equal(await page.locator("#revealed").textContent(), "译文");
  check("viewport completion rescans text revealed by translation reflow without scrolling");
  await restore();
  await worker.evaluate(() => { globalThis.__testMode = "normal"; });

  await clearCache();
  if (live) await worker.evaluate(() => { globalThis.fetch = globalThis.__originalFetch; });
  await page.goto(url);
  await popup.reload();
  await popup.waitForFunction(() => !document.querySelector("#translate").disabled);
  await popup.locator("#scope").selectOption("page");
  await popup.locator("#translate").click();
  await waitComplete();
  const finalStatus = await status();
  assert.equal(finalStatus.failed, 0);
  assert.match(await page.locator("#heading").textContent(), /\p{Script=Han}/u);
  assert.match(await page.locator("#science").textContent(), /12\s*kHz/);
  assert.equal(await page.locator("#formula").evaluate(element => element.outerHTML), originalFormula);
  assert.equal(await page.locator("#paper-link").getAttribute("href"), "https://example.com/paper");
  await popup.waitForFunction(() => document.querySelector("#status").textContent === "当前内容已翻译");
  await new Promise(resolve => setTimeout(resolve, 400));
  await page.screenshot({path: join(output, "translated-page.png"), fullPage: false});
  await popup.screenshot({path: join(output, "popup-complete.png"), fullPage: true});
  check(`${live ? "real DeepSeek" : "mock provider"} translates the page end to end inside the extension`);
  await options.locator("#test").click();
  await options.waitForFunction(() => document.querySelector("#message").textContent.startsWith("连接成功"), null, {timeout: 60000});
  check(`settings connection test succeeds with ${live ? "real DeepSeek" : "the mock provider"}`);
  assert.deepEqual(browserErrors, []);
  check("no browser JavaScript errors");
  await writeFile(join(output, live ? "browser-live-report.json" : "browser-report.json"), JSON.stringify({testedAt: new Date().toISOString(), liveApi: live, checks, finalStatus, browserErrors}, null, 2));
  console.log(`Browser checks passed: ${checks.length}`);
} catch (error) {
  if (context) {
    for (const current of context.pages()) {
      const name = current.url().includes("popup.html") ? "failure-popup" : current.url().includes("/fixture") ? "failure-page" : null;
      if (!name) continue;
      await current.screenshot({path: join(output, `${name}.png`), fullPage: true}).catch(() => {});
      console.log(name, await current.evaluate(() => globalThis.__PAGELINGO_V1__?.status() || document.body.innerText).catch(() => "unavailable"));
    }
  }
  throw error;
} finally {
  if (context) await context.close();
  server.close();
  await rm(temporary, {recursive: true, force: true});
}
