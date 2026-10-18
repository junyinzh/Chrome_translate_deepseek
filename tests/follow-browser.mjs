import assert from "node:assert/strict";
import {chromium} from "playwright";
import {createServer} from "node:http";
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {loadTestSettings} from "../scripts/test-config.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "pagelingo-follow-"));
const extension = join(temporary, "extension");
const live = process.argv.includes("--live");
const settings = await loadTestSettings();
if (live && !settings.apiKey) throw new Error("Configure a local API key before live tests.");
const output = join(root, "test-results");
const checks = [];
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
let otherOrigin;
function serve(request, response) {
  if (request.url === "/redirect") { response.writeHead(302, {location: "/redirected"}); response.end(); return; }
  const title = new URL(request.url, "http://test.invalid").pathname.replace(/[^a-z0-9/-]/gi, "");
  response.writeHead(200, {"content-type": "text/html; charset=utf-8"});
  response.end(`<!doctype html><html lang="en"><head><title>News ${title}</title><style>body{font:18px/1.7 system-ui;max-width:800px;margin:60px auto}nav{display:grid;gap:10px}</style></head><body>
    <main><h1>News article ${title}</h1><p id="article">The town opened a new library this morning. Visitors can read books and attend public lectures.</p></main>
    <nav><a id="same" href="/two">Next article</a><a id="new" href="${otherOrigin}/child" target="_blank" rel="noopener">Open related article</a><a id="cross" href="${otherOrigin}/cross">Read another publication</a><a id="redirect" href="/redirect">Redirected article</a><a id="spa" href="/spa-next">Next without a reload</a></nav>
    <script>document.querySelector('#spa').addEventListener('click',event=>{event.preventDefault();history.pushState({},'', '/spa-next');setTimeout(()=>{document.querySelector('h1').textContent='Another article';document.querySelector('#article').textContent='The railway station reopened after repairs.';},80);});</script>
  </body></html>`);
}
const server = createServer(serve);
const secondServer = createServer(serve);
await Promise.all([new Promise(resolve => server.listen(0, "127.0.0.1", resolve)), new Promise(resolve => secondServer.listen(0, "127.0.0.1", resolve))]);
const origin = `http://127.0.0.1:${server.address().port}`;
otherOrigin = `http://127.0.0.1:${secondServer.address().port}`;
let context;
try {
  await mkdir(output, {recursive: true});
  await cp(root, extension, {recursive: true, filter: source => ![".git", "local-config.json", "node_modules", "test-results", ".browser-profile"].includes(basename(source))});
  const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
  // Pregrant optional permissions in the isolated profile. Native permission
  // dialogs are not rendered by headless Chrome; denial is tested separately.
  manifest.permissions.push("webNavigation");
  manifest.host_permissions.push("http://*/*", "https://*/*");
  delete manifest.optional_permissions;
  delete manifest.optional_host_permissions;
  await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(extension, "mock-provider.js"), `
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (url !== "https://api.deepseek.com/chat/completions" || (await chrome.storage.session.get("testRealAPI")).testRealAPI) return originalFetch(url, init);
      const {blocks} = JSON.parse(JSON.parse(init.body).messages[1].content);
      const translations = blocks.map(block => ({id:block.id,parts:Object.fromEntries(Object.entries(block.parts).map(([key,value])=>[key,"译文："+value]))}));
      return new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{content:JSON.stringify({translations})}}]}),{headers:{"content-type":"application/json"}});
    };
  `);
  await writeFile(join(extension, "background.js"), `import "./mock-provider.js";\n${await readFile(join(extension, "background.js"), "utf8")}`);
  context = await chromium.launchPersistentContext(join(temporary, "profile"), {
    channel: "chromium", headless: true, viewport: {width: 1280, height: 1000},
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).host;
  const errors = [];
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  const saved = await options.evaluate(settings => chrome.runtime.sendMessage({type: "PL_SAVE_SETTINGS", settings}), {
    ...settings, apiKey: live ? settings.apiKey : "mock-api-key", dynamic: true, scope: "page",
  });
  assert.equal(saved.ok, true);
  const page = await context.newPage();
  await page.goto(`${origin}/one`);
  const tabId = await options.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, page.url());
  const popup = await context.newPage();
  await popup.addInitScript(tabId => { chrome.tabs.query = async () => [{id: tabId, url: "http://127.0.0.1/"}]; }, tabId);
  await popup.setViewportSize({width: 364, height: 720});
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForFunction(() => !document.querySelector("#follow-links").disabled);
  async function status(target = tabId) {
    return options.evaluate(async tabId => {
      try { return (await chrome.tabs.sendMessage(tabId, {type: "PL_PAGE_STATUS"})).status; }
      catch { return null; }
    }, target);
  }
  async function waitComplete(target = tabId) {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const value = await status(target);
      if (value?.state === "error") throw new Error(JSON.stringify(value));
      if (value?.state === "complete") { assert.equal(value.failed, 0); return; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out awaiting automatic translation: ${JSON.stringify(await status(target))}`);
  }
  const followStatus = target => options.evaluate(async tabId => (await chrome.runtime.sendMessage({type: "PL_FOLLOW_STATUS", tabId})).follow, target);
  async function toggle() {
    const current = await followStatus(tabId);
    await popup.waitForFunction(enabled => document.querySelector("#follow-links").checked === enabled, current.enabled);
    await popup.locator("#follow-links").click();
    await popup.waitForFunction(() => !document.querySelector("#follow-links").disabled);
  }

  assert.equal((await followStatus(tabId)).enabled, false);
  assert.equal(await status(), null);
  await popup.evaluate(() => { window.originalRequest = chrome.permissions.request; chrome.permissions.request = async () => false; });
  await toggle();
  assert.equal((await followStatus(tabId)).enabled, false);
  assert.match(await popup.locator("#error").textContent(), /未获得/);
  await popup.locator("#translate").click();
  await waitComplete();
  check("follow is off by default; denied optional permission leaves manual translation working");
  await popup.locator("#restore").click();
  await popup.evaluate(() => { chrome.permissions.request = window.originalRequest; });
  await toggle();
  await waitComplete();
  assert.equal((await followStatus(tabId)).enabled, true);
  await popup.waitForFunction(() => document.querySelector("#status").textContent === "当前内容已翻译");
  await popup.waitForTimeout(300); // Let the progress-bar transition finish before capture.
  await popup.locator("body").screenshot({path: join(output, "popup-follow.png")});
  check("enabling the popup switch translates the current page");

  await page.locator("#same").click();
  await page.waitForURL(`${origin}/two`);
  await waitComplete();
  assert.match(await page.locator("h1").textContent(), /译文/);
  check("same-tab next-article links start translation automatically");
  await page.reload();
  await waitComplete();
  check("reloading an enabled page continues automatic translation");

  const childPromise = context.waitForEvent("page");
  await page.locator("#new").click();
  const child = await childPromise;
  await child.waitForURL(`${otherOrigin}/child`);
  const childId = await options.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, child.url());
  await waitComplete(childId);
  assert.equal((await followStatus(childId)).enabled, true);
  check("new-tab links inherit translation even with rel=noopener");

  const unrelated = await context.newPage();
  await unrelated.goto(`${origin}/unrelated`);
  const unrelatedId = await options.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, unrelated.url());
  assert.equal((await followStatus(unrelatedId)).enabled, false);
  assert.equal(await status(unrelatedId), null);
  check("independently opened tabs remain untranslated");

  await page.locator("#cross").click();
  await page.waitForURL(`${otherOrigin}/cross`);
  await waitComplete();
  check("linked navigation across origins keeps translation enabled");
  await page.locator("#redirect").click();
  await page.waitForURL(`${otherOrigin}/redirected`);
  await waitComplete();
  check("server redirects preserve link-follow translation");
  await page.goBack();
  await waitComplete();
  check("back navigation to a visited article retains the reading session");

  await page.locator("#spa").click();
  await page.waitForFunction(() => document.querySelector("#article").textContent.includes("译文") && document.querySelector("#article").textContent.includes("railway"));
  await waitComplete();
  await options.evaluate(tabId => chrome.tabs.sendMessage(tabId, {type: "PL_RESTORE"}), tabId);
  await page.locator("#spa").click();
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal((await status()).state, "idle");
  assert.equal((await page.locator("#article").textContent()).includes("译文"), false);
  check("SPA article changes translate, while restore prevents automatic restart of that document");

  const cdp = await context.newCDPSession(options);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await cdp.detach();
  assert.equal((await followStatus(tabId)).enabled, true);
  await page.locator("#same").click();
  await page.waitForURL(`${otherOrigin}/two`);
  await waitComplete();
  check("follow state and navigation handling survive service-worker termination");

  await toggle();
  assert.equal((await followStatus(tabId)).enabled, false);
  assert.equal((await followStatus(childId)).enabled, false);
  await page.locator("#spa").click();
  await new Promise(resolve => setTimeout(resolve, 850));
  assert.equal((await page.locator("#article").textContent()).includes("译文"), false);
  assert.equal((await status()).state, "paused");
  await child.locator("#same").click();
  await child.waitForURL(`${otherOrigin}/two`);
  assert.equal(await status(childId), null);
  check("switching off pauses the group and prevents translation of SPA changes and child-tab destinations");

  await toggle();
  await waitComplete();
  await page.goto(`${origin}/typed-destination`);
  assert.equal((await followStatus(tabId)).enabled, false);
  assert.equal(await status(), null);
  check("address-bar-style navigation ends the current tab's follow session");

  if (live) {
    await options.evaluate(() => chrome.storage.session.set({testRealAPI: true}));
    await options.evaluate(() => chrome.runtime.sendMessage({type: "PL_CLEAR_CACHE"}));
    await toggle();
    await waitComplete();
    await page.locator("#same").click();
    await page.waitForURL(`${origin}/two`);
    await waitComplete();
    assert.match(await page.locator("#article").textContent(), /\p{Script=Han}/u);
    check("real DeepSeek translates both the selected page and its linked next article");
  }
  assert.deepEqual(errors, []);
  check("no page JavaScript errors");
  await writeFile(join(output, live ? "follow-browser-live-report.json" : "follow-browser-report.json"), JSON.stringify({testedAt: new Date().toISOString(), liveApi: live, checks}, null, 2));
  console.log(`Follow browser checks passed: ${checks.length}`);
} catch (error) {
  console.error(error.message);
  throw error;
} finally {
  await context?.close();
  server.closeAllConnections(); secondServer.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => secondServer.close(resolve))]);
  await rm(temporary, {recursive: true, force: true});
}
