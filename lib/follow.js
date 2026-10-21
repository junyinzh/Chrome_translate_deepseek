export const FOLLOW_PERMISSIONS = {permissions: ["webNavigation"], origins: ["http://*/*", "https://*/*"]};
const STORAGE_KEY = "followTabsV1";

export function pageURL(url) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.hash = "";
    return parsed.href;
  } catch { return null; }
}

export function followsNavigation(details, state) {
  const url = pageURL(details.url);
  if (!url || details.transitionQualifiers?.includes("from_address_bar")) return false;
  if (details.transitionQualifiers?.includes("forward_back")) return state.visited.includes(url);
  return ["link", "reload"].includes(details.transitionType)
    || details.transitionQualifiers?.includes("client_redirect")
    || (state.inherited && details.transitionType === "auto_toplevel");
}

export class FollowNavigation {
  constructor(api, getPublicSettings) {
    this.api = api;
    this.getPublicSettings = getPublicSettings;
    this.pending = Promise.resolve();
    this.loaded = null;
    this.registered = false;
  }

  // Serialize navigation and toggle events to prevent stale child-tab events
  // from re-enabling a reading group after the user switches it off.
  enqueue(action) {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }

  async states() {
    if (!this.loaded) this.loaded = this.api.storage.session.get(STORAGE_KEY).then(data => data[STORAGE_KEY] || {});
    return this.loaded;
  }

  async save() { await this.api.storage.session.set({[STORAGE_KEY]: await this.states()}); }

  async status(tabId) {
    const state = (await this.states())[tabId];
    return {enabled: Boolean(state), error: state?.error || ""};
  }

  async set(tabId, enabled) {
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error("Invalid tab.");
    const states = await this.states();
    if (!enabled) {
      const group = states[tabId]?.group;
      const members = Object.entries(states).filter(([, state]) => state.group === group);
      for (const [id] of members) delete states[id];
      await this.save();
      await this.pauseMembers(members);
      return this.status(tabId);
    }
    if (!await this.api.permissions.contains(FOLLOW_PERMISSIONS)) throw new Error("请先允许网页访问权限，再开启链接自动翻译。");
    this.registerNavigation();
    const frame = await this.api.webNavigation.getFrame({tabId, frameId: 0});
    const url = pageURL(frame?.url);
    if (!url || !frame.documentId) throw new Error("请在普通 HTTP 或 HTTPS 网页上开启。");
    if (!(await this.getPublicSettings()).hasApiKey) throw new Error("请先配置 API Key。");
    states[tabId] ||= {group: crypto.randomUUID(), visited: [], started: [], inherited: false};
    this.remember(states[tabId], frame);
    await this.save();
    await this.start(tabId, frame, true);
    return this.status(tabId);
  }

  remember(state, details) {
    state.documentId = details.documentId;
    state.url = pageURL(details.url);
    state.visited = [...new Set([...state.visited, state.url])].slice(-100);
    state.error = "";
  }

  async committed(details) {
    if (details.frameId !== 0) return;
    const states = await this.states();
    const state = states[details.tabId];
    if (!state) return;
    if (!followsNavigation(details, state)) delete states[details.tabId];
    else { this.remember(state, details); state.inherited = false; }
    await this.save();
  }

  async created(details) {
    if (details.sourceFrameId !== 0 || !pageURL(details.url)) return;
    const states = await this.states();
    const source = states[details.sourceTabId];
    if (!source || states[details.tabId]) return;
    states[details.tabId] = {group: source.group, visited: [pageURL(details.url)], started: [], inherited: true, error: ""};
    await this.save();
    // A fast destination may finish loading before this event is handled.
    const tab = await this.api.tabs.get(details.tabId).catch(() => null);
    if (tab?.status === "complete") {
      const frame = await this.api.webNavigation.getFrame({tabId: details.tabId, frameId: 0}).catch(() => null);
      if (frame && pageURL(frame.url) === pageURL(details.url)) {
        this.remember(states[details.tabId], frame);
        await this.start(details.tabId, frame);
      }
    }
  }

  async ready(details) {
    if (details.frameId === 0) await this.start(details.tabId, details);
  }

  async history(details) {
    if (details.frameId !== 0 || !pageURL(details.url)) return;
    const state = (await this.states())[details.tabId];
    if (!state || state.documentId !== details.documentId) return;
    this.remember(state, details);
    await this.start(details.tabId, details);
  }

  async start(tabId, details, manual = false) {
    const state = (await this.states())[tabId];
    if (!state || !pageURL(details.url) || !details.documentId) return;
    if (state.documentId && state.documentId !== details.documentId) return;
    const key = `${details.documentId}:${pageURL(details.url)}`;
    if (!manual && state.started.includes(key)) return;
    try {
      if (!await this.api.permissions.contains(FOLLOW_PERMISSIONS)) { await this.clear(); return; }
      const frame = await this.api.webNavigation.getFrame({tabId, frameId: 0});
      if (frame?.documentId !== details.documentId || pageURL(frame.url) !== pageURL(details.url)) return;
      const settings = await this.getPublicSettings();
      if (!settings.hasApiKey) throw new Error("请先配置 API Key。");
      await this.api.scripting.executeScript({target: {tabId, documentIds: [details.documentId]}, files: ["content.js"]});
      const result = await this.api.tabs.sendMessage(tabId, {type: manual ? "PL_START" : "PL_AUTO_START", settings}, {documentId: details.documentId});
      if (!result?.ok) throw new Error(result?.error || "自动翻译未启动，请刷新网页重试。");
      state.started = [...state.started.filter(item => item !== key), key].slice(-100);
      state.error = "";
    } catch { state.error = "此页面未能自动翻译，可点击“翻译网页”重试。"; }
    await this.save();
  }

  async pauseMembers(members) {
    await Promise.all(members.map(([id, state]) => this.api.tabs.sendMessage(Number(id), {type: "PL_PAUSE"},
      state.documentId ? {documentId: state.documentId} : {frameId: 0}).catch(() => {})));
  }

  async clear() {
    const members = Object.entries(await this.states());
    this.loaded = Promise.resolve({});
    await this.save();
    await this.pauseMembers(members);
  }

  registerNavigation() {
    if (this.registered || !this.api.webNavigation) return;
    this.registered = true;
    const bind = (event, method) => event.addListener(details => { this.enqueue(() => this[method](details)).catch(() => {}); });
    bind(this.api.webNavigation.onCommitted, "committed");
    bind(this.api.webNavigation.onCreatedNavigationTarget, "created");
    bind(this.api.webNavigation.onDOMContentLoaded, "ready");
    bind(this.api.webNavigation.onCompleted, "ready");
    bind(this.api.webNavigation.onHistoryStateUpdated, "history");
  }

  register() {
    // Synchronous registration restores event listeners on worker wake-up.
    this.registerNavigation();
    this.api.permissions.onAdded.addListener(() => this.registerNavigation());
    this.api.permissions.onRemoved.addListener(() => {
      this.enqueue(async () => { if (!await this.api.permissions.contains(FOLLOW_PERMISSIONS)) await this.clear(); }).catch(() => {});
    });
    this.api.tabs.onRemoved.addListener(tabId => {
      this.enqueue(async () => { delete (await this.states())[tabId]; await this.save(); }).catch(() => {});
    });
  }
}
