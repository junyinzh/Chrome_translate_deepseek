const $ = selector => document.querySelector(selector);
let tab;
let settings;
let pageStatus = {state: "idle", active: false, total: 0};
let busy = false;
let supported = false;

function showError(message = "") {
  $("#error").textContent = message;
  $("#error").hidden = !message;
}

async function background(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || "插件后台未响应，请重新加载插件。");
  return result;
}

async function page(message, inject = false) {
  let result;
  try { result = await chrome.tabs.sendMessage(tab.id, message); }
  catch (error) {
    if (!inject) return null;
    try { await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ["content.js"]}); }
    catch { throw new Error("无法访问这个页面。请换一个普通网页；本地文件需要在插件详情中允许访问文件网址。"); }
    result = await chrome.tabs.sendMessage(tab.id, message);
  }
  if (!result?.ok) throw new Error(result?.error || "网页没有响应，请刷新后重试。");
  return result.status;
}

function render() {
  const status = pageStatus;
  const active = status.active;
  const labels = {idle: settings?.hasApiKey ? "已就绪" : "请先设置 API Key", paused: "翻译已暂停", translating: "正在翻译网页", complete: status.total ? "当前内容已翻译" : "没有找到需要翻译的文字", error: "部分段落翻译失败"};
  $("#status").textContent = !supported ? "此页面不支持翻译" : labels[status.state] || "已就绪";
  $("#dot").className = `dot ${status.state === "translating" ? "busy" : status.state === "error" ? "error" : "ready"}`;
  $("#progress").style.width = `${status.total ? Math.min(100, (status.processed || 0) / status.total * 100) : 0}%`;
  const tokens = (status.promptTokens || 0) + (status.completionTokens || 0);
  $("#detail").textContent = !supported ? "请打开文章、新闻或文档等普通网页。" : status.total
    ? `${status.translated || 0} / ${status.total} 段已替换${status.cacheHits ? ` · ${status.cacheHits} 段缓存` : ""}${status.failed ? ` · ${status.failed} 段失败` : ""}${tokens ? `\n本次用量 ${tokens.toLocaleString()} tokens` : ""}`
    : settings?.hasApiKey ? "DeepSeek 已配置 · 点击下方开始翻译" : "点击右上角设置，填写后即可使用。";
  $("#detail").style.whiteSpace = "pre-line";
  $("#translate").textContent = active ? "暂停翻译" : status.failed ? "重试失败段落" : status.state === "paused" ? "继续翻译" : "翻译网页";
  $("#translate").disabled = busy || !supported || !settings?.hasApiKey;
  $("#restore").disabled = busy || !supported || !status.total;
  $("#language").disabled = busy || active;
  $("#scope").disabled = busy || active;
  if (status.error) showError(status.error);
}

async function refresh() {
  if (busy || !supported) return;
  try {
    const status = await page({type: "PL_PAGE_STATUS"});
    if (status) { pageStatus = status; render(); }
  } catch { /* A page navigation may disconnect the previous content script. */ }
}

$("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("#translate").addEventListener("click", async () => {
  busy = true;
  showError();
  render();
  try {
    if (pageStatus.active) pageStatus = await page({type: "PL_PAUSE"});
    else {
      const result = await background({type: "PL_SAVE_SETTINGS", settings: {targetLanguage: $("#language").value, scope: $("#scope").value}});
      settings = result.settings;
      pageStatus = await page({type: "PL_START", settings}, true);
    }
  } catch (error) { showError(error.message); }
  finally { busy = false; render(); }
});
$("#restore").addEventListener("click", async () => {
  busy = true;
  render();
  try { pageStatus = await page({type: "PL_RESTORE"}); showError(); }
  catch (error) { showError(error.message); }
  finally { busy = false; render(); }
});

try {
  const result = await background({type: "PL_PUBLIC_SETTINGS"});
  settings = result.settings;
  $("#language").value = settings.targetLanguage;
  $("#scope").value = settings.scope;
  $("#model").textContent = settings.model;
  [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  supported = Boolean(tab?.id && /^(https?:|file:)/.test(tab.url || ""));
  if (supported) {
    $("#site").textContent = tab.url.startsWith("file:") ? "本地网页" : new URL(tab.url).hostname;
    pageStatus = await page({type: "PL_PAGE_STATUS"}) || pageStatus;
  }
  render();
  setInterval(refresh, 800);
} catch (error) {
  showError(error.message);
  $("#status").textContent = "初始化失败";
}
