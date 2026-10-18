import {requestTranslation, TranslationError, waitForRetry} from "./api.js";

export const FATAL_CODES = new Set(["NO_API_KEY", "HTTP_400", "HTTP_401", "HTTP_402", "HTTP_403", "HTTP_404"]);

// Retain good paragraphs immediately. Repair only failures, with progressively
// smaller requests and a bounded total number of provider calls.
export async function translateResilient(blocks, settings, {
  signal, title = "", onProgress = async () => {}, request = requestTranslation,
  wait = waitForRetry, requestTimeoutMs = 30000, maxRequests = 32,
} = {}) {
  const translations = new Map();
  const usage = {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0};
  const diagnostics = {requests: 0, retries: 0, recovered: 0, errorCounts: {}};
  const recordError = code => { diagnostics.errorCounts[code] = (diagnostics.errorCounts[code] || 0) + 1; };
  const failure = (group, error) => ({translations: [], errors: group.map(block => ({
    id: block.id, code: error.code || "NETWORK_ERROR", error: error instanceof TypeError ? "无法连接 DeepSeek。" : error.message,
  }))});

  async function call(group, repairing = false) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (diagnostics.requests >= maxRequests) return failure(group, new TranslationError("已达到自动重试上限，请手动重试剩余段落。", "RETRY_LIMIT"));
      diagnostics.requests++;
      if (repairing || attempt) diagnostics.retries++;
      await onProgress({phase: repairing || attempt ? "retry" : "request"});
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener("abort", abort, {once: true});
      if (signal?.aborted) abort();
      const timer = setTimeout(() => controller.abort("request_timeout"), requestTimeoutMs);
      let retryDelay;
      try {
        const result = await request(group, settings, {signal: controller.signal, title, partial: true});
        for (const key of Object.keys(usage)) usage[key] += result.usage?.[key] || 0;
        for (const error of result.errors || []) recordError(error.code);
        return {...result, errors: result.errors || []};
      } catch (error) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (controller.signal.reason === "request_timeout") error = new TranslationError("单次翻译超时。", "TIMEOUT", true);
        if (FATAL_CODES.has(error.code)) throw error;
        recordError(error.code || "NETWORK_ERROR");
        // Schema errors and timeouts should shrink the request instead of
        // repeating the same oversized or structurally difficult batch.
        const transient = error instanceof TypeError || error.code === "HTTP_429" || /^HTTP_5\d\d$/.test(error.code || "");
        if (!transient || attempt === 1) return failure(group, error);
        retryDelay = error.retryAfterMs ?? 900;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
      await onProgress({phase: "retry"});
      await wait(retryDelay, signal);
    }
  }

  async function accept(items) {
    const fresh = items.filter(item => !translations.has(item.id));
    for (const item of fresh) translations.set(item.id, item);
    if (fresh.length) await onProgress({translations: fresh});
  }

  const initial = await call(blocks);
  await accept(initial.translations);
  const errors = [];
  for (const block of blocks.filter(block => !translations.has(block.id))) {
    let result = await call([block], true);
    if (!result.translations.length && block.parts.length > 1) {
      const parts = [];
      let failed;
      // At most eight explicitly numbered fragments per repair request. A
      // paragraph-wide context preserves meaning across hyperlink boundaries.
      for (let start = 0; start < block.parts.length; start += 8) {
        const piece = {id: block.id, parts: block.parts.slice(start, start + 8), context: block.parts.join("")};
        const repaired = await call([piece], true);
        if (!repaired.translations.length) { failed = repaired.errors[0]; break; }
        parts.push(...repaired.translations[0].parts);
      }
      result = failed ? {translations: [], errors: [failed]} : {translations: [{id: block.id, parts}], errors: []};
    }
    if (result.translations.length) {
      diagnostics.recovered++;
      await accept(result.translations);
    } else errors.push(result.errors[0] || {id: block.id, code: "INVALID_TRANSLATION", error: "段落翻译失败，请重试。"});
  }
  return {translations: [...translations.values()], errors, usage, diagnostics};
}
