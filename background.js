import {normalizeSettings, publicSettings} from "./lib/settings.js";
import {requestTranslation, validateBlocks, PROMPT_VERSION, waitForRetry} from "./lib/api.js";

const controllers = new Map();
const cancelledJobs = new Set();
let settingsPromise;
let cachePromise;
let cacheWrite = Promise.resolve();

async function getSettings() {
  if (!settingsPromise) settingsPromise = (async () => {
    await chrome.storage.local.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"});
    const stored = await chrome.storage.local.get("settings");
    if (stored.settings) return normalizeSettings(stored.settings);
    let local = {};
    try {
      const response = await fetch(chrome.runtime.getURL("local-config.json"));
      if (response.ok) local = await response.json();
    } catch { /* A local bootstrap file is optional. */ }
    const settings = normalizeSettings(local);
    await chrome.storage.local.set({settings});
    return settings;
  })().catch(error => { settingsPromise = null; throw error; });
  return settingsPromise;
}

function isExtensionPage(sender) {
  return sender.url?.startsWith(chrome.runtime.getURL(""));
}

async function getCache() {
  if (!cachePromise) cachePromise = chrome.storage.local.get("translationCacheV1")
    .then(data => new Map(Array.isArray(data.translationCacheV1) ? data.translationCacheV1 : []));
  return cachePromise;
}

async function cacheKey(block, settings, title) {
  const value = JSON.stringify([PROMPT_VERSION, settings.model, settings.targetLanguage, settings.glossary, String(title || "").slice(0, 300), block.parts]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

function holdRequestLease() {
  // Keep only bounded, in-flight network work alive under Manifest V3's idle timer.
  const interval = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
  return () => clearInterval(interval);
}

function persistCache(cache) {
  cacheWrite = cacheWrite.catch(() => {}).then(async () => {
    while (cache.size > 1200) cache.delete(cache.keys().next().value);
    let entries = [...cache];
    while (JSON.stringify(entries).length > 900000 && entries.length) {
      cache.delete(entries[0][0]);
      entries = [...cache];
    }
    await chrome.storage.local.set({translationCacheV1: entries});
  });
  return cacheWrite;
}

async function translate(message, sender) {
  if (!sender.tab || sender.frameId !== 0) throw new Error("Unsupported page context.");
  validateBlocks(message.blocks);
  if (typeof message.jobId !== "string" || message.jobId.length > 100
    || typeof message.batchId !== "string" || message.batchId.length > 100) throw new Error("Invalid job.");
  const storedSettings = await getSettings();
  const settings = normalizeSettings({...storedSettings, ...message.preferences, apiKey: storedSettings.apiKey});
  const cache = await getCache();
  const keys = await Promise.all(message.blocks.map(block => cacheKey(block, settings, message.title)));
  const translations = [];
  const missing = [];
  let cacheHits = 0;
  message.blocks.forEach((block, i) => {
    const saved = cache.get(keys[i]);
    if (saved && saved.length === block.parts.length && saved.every(part => typeof part === "string")) {
      translations.push({id: block.id, parts: saved});
      cacheHits++;
    } else missing.push(block);
  });
  if (!missing.length) return {translations, cacheHits, usage: null};
  if (cancelledJobs.has(`${sender.tab.id}:${message.jobId}`)) throw Object.assign(new Error("翻译已暂停。"), {code: "ABORTED"});
  const id = `${sender.tab.id}:${message.jobId}:${message.batchId}`;
  const controller = new AbortController();
  controllers.set(id, controller);
  const releaseLease = holdRequestLease();
  const timeout = setTimeout(() => controller.abort("timeout"), 90000);
  let result;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await requestTranslation(missing, settings, {signal: controller.signal, title: message.title});
        break;
      } catch (error) {
        if (controller.signal.aborted) {
          const timeout = controller.signal.reason === "timeout";
          throw Object.assign(new Error(timeout ? "翻译请求超时，请稍后重试。" : "翻译已暂停。"), {code: timeout ? "TIMEOUT" : "ABORTED"});
        }
        const retryable = error.retryable || error instanceof TypeError;
        if (!retryable || attempt === 2) throw error;
        await waitForRetry(900 * 2 ** attempt, controller.signal);
      }
    }
    translations.push(...result.translations);
    for (let i = 0; i < message.blocks.length; i++) {
      const translated = result.translations.find(item => item.id === message.blocks[i].id);
      if (translated) cache.set(keys[i], translated.parts);
    }
    await persistCache(cache).catch(() => {});
    return {translations, cacheHits, usage: result.usage};
  } finally {
    clearTimeout(timeout);
    releaseLease();
    controllers.delete(id);
  }
}

async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error("Unknown sender.");
  switch (message.type) {
    case "PL_PUBLIC_SETTINGS": return {settings: publicSettings(await getSettings())};
    case "PL_GET_SETTINGS": {
      if (!isExtensionPage(sender)) throw new Error("Settings are available only in extension pages.");
      return {settings: await getSettings()};
    }
    case "PL_SAVE_SETTINGS": {
      if (!isExtensionPage(sender)) throw new Error("Unsupported context.");
      const settings = normalizeSettings({...await getSettings(), ...message.settings});
      await chrome.storage.local.set({settings});
      settingsPromise = Promise.resolve(settings);
      return {settings: publicSettings(settings)};
    }
    case "PL_TRANSLATE_BATCH": return translate(message, sender);
    case "PL_CANCEL_JOB": {
      if (!sender.tab || sender.frameId !== 0) throw new Error("Unsupported context.");
      cancelledJobs.add(`${sender.tab.id}:${message.jobId}`);
      if (cancelledJobs.size > 300) cancelledJobs.delete(cancelledJobs.values().next().value);
      const prefix = `${sender.tab.id}:${message.jobId}:`;
      for (const [id, controller] of controllers) if (id.startsWith(prefix)) controller.abort("cancelled");
      return {};
    }
    case "PL_TEST_CONNECTION": {
      if (!isExtensionPage(sender)) throw new Error("Unsupported context.");
      const settings = normalizeSettings({...await getSettings(), ...message.settings});
      const controller = new AbortController();
      const releaseLease = holdRequestLease();
      const timeout = setTimeout(() => controller.abort(), 45000);
      try {
        const result = await requestTranslation([{id: "test", parts: ["The connection is working."]}], settings, {signal: controller.signal});
        return {text: result.translations[0].parts.join(""), usage: result.usage, model: settings.model};
      } finally { clearTimeout(timeout); releaseLease(); }
    }
    case "PL_CLEAR_CACHE": {
      if (!isExtensionPage(sender)) throw new Error("Unsupported context.");
      const cache = await getCache();
      cache.clear();
      await persistCache(cache);
      return {};
    }
    default: throw new Error("Unknown request.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type?.startsWith("PL_")) return false;
  handle(message, sender).then(result => sendResponse({ok: true, ...result}), error => {
    const code = error.code || (error.name === "AbortError" ? "ABORTED" : "NETWORK_ERROR");
    sendResponse({ok: false, error: error instanceof TypeError ? "无法连接 DeepSeek，请检查网络后重试。" : error.message, code,
      fatal: ["NO_API_KEY", "HTTP_400", "HTTP_401", "HTTP_402", "HTTP_403", "HTTP_404"].includes(code)});
  });
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  for (const [id, controller] of controllers) if (id.startsWith(`${tabId}:`)) controller.abort("tab_closed");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  for (const [id, controller] of controllers) if (id.startsWith(`${tabId}:`)) controller.abort("page_navigated");
});

chrome.runtime.onInstalled.addListener(() => { getSettings().catch(() => {}); });
