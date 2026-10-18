(() => {
  if (globalThis.__PAGELINGO_V1__) return;

  const EXCLUDED = [
    "script", "style", "noscript", "textarea", "input", "select", "option", "pre", "code", "kbd", "samp",
    "svg", "math", "mjx-container", ".katex", ".MathJax", "[translate='no']", ".notranslate",
    "[role='textbox']", "[data-pagelingo-ui]", "[inert]", "[hidden]", ".reference", ".mw-ref",
  ].join(",");
  const SECONDARY = "nav,aside,footer,[role='navigation'],[role='complementary'],.infobox,.sidebar,.navbox,.vertical-navbox,.hatnote,.mw-editsection,.mw-indicators,.catlinks,.printfooter,#coordinates,#siteSub,#contentSub,.vector-page-toolbar,.vector-dropdown,.vector-toc";
  const BLOCK_DISPLAY = /^(block|flow-root|flex|grid|list-item|table-cell|table-caption|table-row|inline-block|inline-flex|inline-grid)$/;
  const fatalCodes = new Set(["NO_API_KEY", "HTTP_400", "HTTP_401", "HTTP_402", "HTTP_403", "HTTP_404"]);

  function send(message) {
    return chrome.runtime.sendMessage(message);
  }

  function splitText(text, limit = 2200) {
    const pieces = [];
    let rest = text;
    while (rest.length > limit) {
      let end = limit;
      const prefix = rest.slice(0, limit);
      const boundary = Math.max(prefix.lastIndexOf(". "), prefix.lastIndexOf("; "), prefix.lastIndexOf("\n"), prefix.lastIndexOf(" "));
      if (boundary > limit * 0.5) end = boundary + 1;
      if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
      pieces.push(rest.slice(0, end));
      rest = rest.slice(end);
    }
    if (rest) pieces.push(rest);
    return pieces;
  }

  function preserveWhitespace(original, translated) {
    if (!translated) return "";
    const leading = original.match(/^\s*/)[0];
    const trailing = original.match(/\s*$/)[0];
    return leading + translated.trim() + trailing;
  }

  function signature(settings) {
    return JSON.stringify([settings.targetLanguage, settings.model, settings.glossary, settings.scope]);
  }

  class PageTranslator {
    constructor() {
      this.records = new Set();
      this.byNode = new WeakMap();
      this.queue = [];
      this.inflight = new Map();
      this.failedUnits = [];
      this.serial = 0;
      this.active = false;
      this.jobId = null;
      this.settings = null;
      this.stats = this.emptyStats();
      this.state = "idle";
      this.error = "";
      this.scanTimer = null;
      this.warmup = true;
      this.retrying = new Set();
      this.observer = new MutationObserver(mutations => this.onMutations(mutations));
      this.onScroll = () => this.scheduleScan();
    }

    emptyStats() {
      return {total: 0, processed: 0, translated: 0, failed: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0,
        requests: 0, retries: 0, recovered: 0, errorCounts: {}};
    }

    status() {
      return {state: this.state, active: this.active, ...this.stats, queued: this.queue.length,
        inFlight: this.inflight.size, retrying: this.retrying.size, error: this.error, targetLanguage: this.settings?.targetLanguage};
    }

    async start(settings) {
      if (!settings.hasApiKey) throw new Error("请先在设置中填写 API Key。");
      if (this.settings && signature(this.settings) !== signature(settings)) this.restore();
      if (this.active) return this.status();
      this.settings = settings;
      this.active = true;
      this.error = "";
      this.warmup = true;
      this.jobId = crypto.randomUUID();
      if (this.failedUnits.length) {
        this.stats.total -= this.failedUnits.length;
        this.stats.processed -= this.failedUnits.length;
        this.stats.failed = 0;
        this.queue.push(...this.failedUnits);
        for (const unit of this.failedUnits) unit.settled = false;
        this.stats.total += this.failedUnits.length;
        this.failedUnits = [];
      }
      this.createToolbar();
      if (settings.dynamic) this.observer.observe(document.body || document.documentElement, {subtree: true, childList: true, characterData: true});
      window.addEventListener("scroll", this.onScroll, {passive: true, capture: true});
      this.scan();
      this.pump();
      return this.status();
    }

    pause() {
      const oldJob = this.jobId;
      this.active = false;
      this.jobId = null;
      this.observer.disconnect();
      window.removeEventListener("scroll", this.onScroll, true);
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
      const pending = [...this.inflight.values()].flat().filter(unit => !unit.settled);
      this.queue.unshift(...pending);
      this.inflight.clear();
      this.retrying.clear();
      if (oldJob) send({type: "PL_CANCEL_JOB", jobId: oldJob}).catch(() => {});
      this.state = this.stats.total ? "paused" : "idle";
      this.renderToolbar();
      return this.status();
    }

    restore() {
      this.pause();
      for (const record of this.records) {
        if (record.node.isConnected && record.node.data === record.expected) record.node.data = record.original;
      }
      this.records.clear();
      this.byNode = new WeakMap();
      this.queue = [];
      this.failedUnits = [];
      this.stats = this.emptyStats();
      this.error = "";
      this.state = "idle";
      this.renderToolbar();
      return this.status();
    }

    eligible(node) {
      if (!node.data.trim()) return false;
      const parent = node.parentElement;
      if (!parent || parent.isContentEditable || parent.closest(EXCLUDED)) return false;
      if (parent.closest("[contenteditable]:not([contenteditable='false'])")) return false;
      if (!parent.getClientRects().length) return false;
      if (typeof parent.checkVisibility === "function" && !parent.checkVisibility({checkVisibilityCSS: true, checkOpacity: true})) return false;
      const style = getComputedStyle(parent);
      if (style.visibility === "hidden" || style.visibility === "collapse") return false;
      return true;
    }

    blockFor(parent) {
      let element = parent;
      while (element.parentElement && element !== document.body) {
        if (BLOCK_DISPLAY.test(getComputedStyle(element).display) || element.tagName === "BR") break;
        element = element.parentElement;
      }
      return element;
    }

    shouldTranslate(text) {
      return /\p{L}/u.test(text);
    }

    scan(pump = true) {
      if (!this.active || !document.body) return;
      const groups = new Map();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      let count = 0;
      while ((node = walker.nextNode())) {
        const previous = this.byNode.get(node);
        if (previous && previous.expected === node.data) continue;
        if (!this.eligible(node)) continue;
        const block = this.blockFor(node.parentElement);
        const rect = block.getBoundingClientRect();
        if (this.settings.scope === "viewport" && (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth)) continue;
        if (!groups.has(block)) groups.set(block, []);
        groups.get(block).push(node);
        if (++count >= 15000) break;
      }
      const units = [];
      for (const [element, nodes] of groups) {
        if (!this.shouldTranslate(nodes.map(node => node.data).join(""))) continue;
        let entries = [];
        let length = 0;
        const flush = () => {
          if (!entries.length) return;
          units.push({id: `p${++this.serial}`, entries, length, element, order: this.serial, settled: false});
          entries = [];
          length = 0;
        };
        for (const node of nodes) {
          const previous = this.byNode.get(node);
          if (previous) this.records.delete(previous);
          const pieces = splitText(node.data);
          const record = {node, original: node.data, expected: node.data, pieces, translated: new Map()};
          this.byNode.set(node, record);
          this.records.add(record);
          for (let index = 0; index < pieces.length; index++) {
            if (entries.length && (length + pieces[index].length > 2400 || entries.length >= 50)) flush();
            entries.push({record, index, text: pieces[index]});
            length += pieces[index].length;
          }
        }
        flush();
      }
      this.queue.push(...units);
      this.stats.total += units.length;
      this.pruneRecords();
      if (pump) this.pump();
    }

    pruneRecords() {
      for (const record of this.records) if (!record.node.isConnected) this.records.delete(record);
    }

    onMutations(mutations) {
      if (!this.active) return;
      const meaningful = mutations.some(mutation => {
        if (mutation.type === "characterData") {
          const record = this.byNode.get(mutation.target);
          return !record || record.expected !== mutation.target.data;
        }
        return [...mutation.addedNodes].some(node => node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE);
      });
      if (meaningful) this.scheduleScan();
    }

    scheduleScan() {
      if (!this.active || this.scanTimer) return;
      this.scanTimer = setTimeout(() => {
        this.scanTimer = null;
        this.scan();
      }, 600);
    }

    sortQueue() {
      for (const unit of this.queue) {
        const {top, bottom} = unit.element.getBoundingClientRect();
        const isSecondary = Boolean(unit.element.closest(SECONDARY));
        const inArticle = Boolean(unit.element.closest("article,main,[role='main'],#mw-content-text"));
        const isTitle = unit.element.matches("h1,#firstHeading") && !isSecondary;
        const isBody = isTitle || (!isSecondary && (inArticle || unit.element.matches("p,h2,h3,h4,h5,h6,blockquote")));
        const visible = bottom >= 0 && top < innerHeight;
        unit.priority = isBody ? visible ? 0 : top >= innerHeight ? top < innerHeight * 2 ? 1 : 3 : 4
          : visible ? 2 : 5;
        unit.top = top;
      }
      // Recompute positions after page reflow or scrolling, not only at discovery.
      this.queue.sort((a, b) => a.priority - b.priority || a.top - b.top || a.order - b.order);
    }

    nextBatch() {
      const batch = [];
      let length = 0;
      let parts = 0;
      const urgent = this.warmup || this.queue[0]?.priority === 0;
      while (this.queue.length && batch.length < (urgent ? 2 : 4)) {
        const next = this.queue[0];
        if (batch.length && (length + next.length > (urgent ? 2400 : 3600)
          || parts + next.entries.length > 60 || next.priority !== batch[0].priority)) break;
        this.queue.shift();
        const valid = next.entries.some(entry => entry.record.node.isConnected && entry.record.node.data === entry.record.expected);
        if (!valid) { this.stats.processed++; continue; }
        batch.push(next);
        length += next.length;
        parts += next.entries.length;
      }
      return batch;
    }

    pump() {
      if (!this.active) return;
      // Translation can shorten the page and reveal new text without a scroll.
      if (this.settings.scope === "viewport" && !this.queue.length && !this.inflight.size) this.scan(false);
      this.sortQueue();
      // Finish one small opening batch before spending concurrency on later text.
      while (this.inflight.size < (this.warmup ? 1 : this.settings.concurrency) && this.queue.length) {
        const batch = this.nextBatch();
        if (!batch.length) continue;
        const batchId = crypto.randomUUID();
        this.inflight.set(batchId, batch);
        this.runBatch(batch, batchId, this.jobId);
      }
      this.state = this.inflight.size || this.queue.length ? "translating" : this.error ? "error" : "complete";
      if (this.state === "error") {
        this.pause();
        this.state = "error";
      }
      this.renderToolbar();
    }

    apply(unit, parts) {
      let applied = false;
      for (let i = 0; i < unit.entries.length; i++) {
        const {record, index, text} = unit.entries[i];
        if (!record.node.isConnected || record.node.data !== record.expected || this.byNode.get(record.node) !== record) continue;
        record.translated.set(index, preserveWhitespace(text, parts[i]));
        record.expected = record.pieces.map((piece, index) => record.translated.has(index) ? record.translated.get(index) : piece).join("");
        record.node.data = record.expected;
        applied = true;
      }
      return applied;
    }

    receiveProgress(message) {
      if (this.jobId !== message.jobId) return;
      const batch = this.inflight.get(message.batchId);
      if (!batch) return;
      if (message.phase === "retry") this.retrying.add(message.batchId);
      if (message.phase === "request") this.retrying.delete(message.batchId);
      this.acceptTranslations(batch, message.translations || []);
      if (message.cacheHits) {
        this.stats.cacheHits += Math.max(0, message.cacheHits - (batch.reportedCacheHits || 0));
        batch.reportedCacheHits = message.cacheHits;
      }
      this.renderToolbar();
    }

    acceptTranslations(batch, translations) {
      const byId = new Map(translations.map(item => [item.id, item.parts]));
      for (const unit of batch) {
        const parts = byId.get(unit.id);
        if (unit.settled || !parts || parts.length !== unit.entries.length) continue;
        if (this.apply(unit, parts)) this.stats.translated++;
        this.stats.processed++;
        unit.settled = true;
      }
    }

    failUnits(units, message, code = "NETWORK_ERROR") {
      for (const unit of units.filter(unit => !unit.settled)) {
        unit.settled = true;
        this.stats.failed++;
        this.stats.processed++;
        this.failedUnits.push(unit);
      }
      this.error = `${message} [${code}]`;
    }

    async runBatch(batch, batchId, jobId) {
      try {
        const result = await send({type: "PL_TRANSLATE_BATCH", jobId, batchId, title: document.title,
          preferences: {targetLanguage: this.settings.targetLanguage, model: this.settings.model, glossary: this.settings.glossary},
          blocks: batch.map(unit => ({id: unit.id, parts: unit.entries.map(entry => entry.text)}))});
        if (this.jobId !== jobId) return;
        if (!result?.ok) {
          const error = new Error(result?.error || "翻译服务没有响应，请重试。");
          error.fatal = result?.fatal || fatalCodes.has(result?.code);
          error.code = result?.code;
          throw error;
        }
        this.acceptTranslations(batch, result.translations);
        for (const unit of batch.filter(unit => !unit.settled)) {
          const failure = result.errors?.find(item => item.id === unit.id);
          this.failUnits([unit], failure?.error || "译文段落格式不匹配，请重试。", failure?.code || "INVALID_TRANSLATION");
        }
        this.stats.cacheHits += Math.max(0, (result.cacheHits || 0) - (batch.reportedCacheHits || 0));
        this.stats.promptTokens += result.usage?.prompt_tokens || 0;
        this.stats.completionTokens += result.usage?.completion_tokens || 0;
        for (const field of ["requests", "retries", "recovered"]) this.stats[field] += result.diagnostics?.[field] || 0;
        for (const [code, count] of Object.entries(result.diagnostics?.errorCounts || {})) this.stats.errorCounts[code] = (this.stats.errorCounts[code] || 0) + count;
      } catch (error) {
        if (this.jobId !== jobId) return;
        this.failUnits(batch, error.message.includes("Extension context invalidated") ? "插件已更新，请刷新网页后重试。" : error.message, error.code);
        if (error.fatal) {
          this.inflight.delete(batchId);
          this.pause();
          this.state = "error";
          this.renderToolbar();
        }
      } finally {
        if (this.jobId === jobId) {
          this.warmup = false;
          this.retrying.delete(batchId);
          this.inflight.delete(batchId);
          this.pump();
        }
      }
    }

    createToolbar() {
      if (this.toolbar?.isConnected) { this.toolbar.style.display = "block"; return; }
      const host = document.createElement("div");
      host.dataset.pagelingoUi = "true";
      host.style.cssText = "all:initial!important;position:fixed!important;bottom:22px!important;right:22px!important;z-index:2147483647!important;display:block!important;";
      const shadow = host.attachShadow({mode: "closed"});
      shadow.innerHTML = `<style>
        :host{color-scheme:light}*{box-sizing:border-box}.card{width:294px;padding:16px;border:1px solid #dce4e2;border-radius:16px;background:#fff;color:#18332e;box-shadow:0 12px 44px #103a2d29;font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
        header{display:flex;align-items:center;gap:8px;margin-bottom:10px}b{font-size:14px}.mark{background:#e4f3ed;color:#127759;border-radius:7px;padding:1px 7px;font-weight:700}.close{margin-left:auto;background:none;border:0;color:#81918b;font-size:19px;cursor:pointer;padding:0 3px}
        .status{margin-bottom:7px;overflow-wrap:anywhere}.track{height:4px;background:#e9efec;border-radius:5px;overflow:hidden}.fill{height:100%;background:#168467;transition:width .2s}.meta{font-size:11px;color:#73857e;margin:7px 0 12px}.actions{display:flex;gap:7px}button{font:inherit;border:1px solid #d9e4df;border-radius:8px;background:#f7faf8;color:#274a3e;padding:6px 11px;cursor:pointer}.primary{background:#15785d;color:white;border-color:#15785d}button:hover{filter:brightness(.96)}button:disabled{opacity:.5;cursor:default}
      </style><section class="card" aria-label="PageLingo translation"><header><span class="mark">文</span><b>PageLingo</b><button class="close" title="收起" aria-label="收起">×</button></header><div class="status" role="status"></div><div class="track"><div class="fill"></div></div><div class="meta"></div><div class="actions"><button class="primary toggle"></button><button class="restore">恢复原文</button></div></section>`;
      shadow.querySelector(".toggle").addEventListener("click", async () => {
        if (this.active) this.pause();
        else {
          try {
            const response = await send({type: "PL_PUBLIC_SETTINGS"});
            if (!response.ok) throw new Error(response.error);
            await this.start(response.settings);
          } catch (error) { this.error = error.message; this.state = "error"; this.renderToolbar(); }
        }
      });
      shadow.querySelector(".restore").addEventListener("click", () => this.restore());
      shadow.querySelector(".close").addEventListener("click", () => { host.style.setProperty("display", "none", "important"); });
      document.documentElement.append(host);
      this.toolbar = host;
      this.toolbarRoot = shadow;
      this.renderToolbar();
    }

    renderToolbar() {
      if (!this.toolbarRoot) return;
      const {total, processed, translated, failed, cacheHits} = this.stats;
      const labels = {idle: "原文显示中", paused: "翻译已暂停", error: this.error || "部分段落翻译失败", complete: total ? "当前内容已翻译" : "没有找到需要翻译的文字"};
      const status = this.state === "translating" ? `${this.retrying.size ? "正在修复个别段落" : "正文优先翻译"} · ${processed} / ${total} 段` : labels[this.state];
      this.toolbarRoot.querySelector(".status").textContent = status;
      this.toolbarRoot.querySelector(".fill").style.width = `${total ? Math.min(100, processed / total * 100) : 0}%`;
      this.toolbarRoot.querySelector(".meta").textContent = `${translated} 段已替换${cacheHits ? ` · ${cacheHits} 段来自缓存` : ""}${this.stats.recovered ? ` · ${this.stats.recovered} 段自动修复` : ""}${failed ? ` · ${failed} 段失败` : ""}${this.state === "translating" ? ` · ${this.inflight.size} 请求中` : ""}${this.active && this.settings.dynamic && this.state === "complete" ? " · 自动翻译新增内容" : ""}`;
      this.toolbarRoot.querySelector(".toggle").textContent = this.active ? "暂停" : failed ? "重试" : this.state === "paused" ? "继续翻译" : "翻译网页";
      this.toolbarRoot.querySelector(".restore").disabled = !this.records.size;
    }
  }

  const translator = new PageTranslator();
  globalThis.__PAGELINGO_V1__ = translator;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === "PL_BATCH_PROGRESS") {
      translator.receiveProgress(message);
      sendResponse({ok: true});
      return false;
    }
    if (!["PL_PAGE_STATUS", "PL_START", "PL_PAUSE", "PL_RESTORE"].includes(message?.type)) return false;
    (async () => {
      if (message.type === "PL_START") return translator.start(message.settings);
      if (message.type === "PL_PAUSE") return translator.pause();
      if (message.type === "PL_RESTORE") return translator.restore();
      return translator.status();
    })().then(status => sendResponse({ok: true, status}), error => sendResponse({ok: false, error: error.message}));
    return true;
  });
})();
