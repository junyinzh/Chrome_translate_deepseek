const MAX_CONCURRENCY = 12;

export const DEFAULTS = Object.freeze({
  apiKey: "",
  model: "deepseek-flash",
  targetLanguage: "zh-Hans",
  scope: "page",
  concurrency: MAX_CONCURRENCY,
  dynamic: true,
  glossary: "",
});

export const LANGUAGES = Object.freeze({
  "zh-Hans": "Simplified Chinese",
  "zh-Hant": "Traditional Chinese",
  en: "English",
  de: "German",
  fr: "French",
  ja: "Japanese",
  es: "Spanish",
});

export function normalizeSettings(input = {}) {
  const result = {...DEFAULTS};
  result.apiKey = String(input.apiKey ?? DEFAULTS.apiKey).trim().slice(0, 256);
  result.model = String(input.model || DEFAULTS.model).trim().slice(0, 100);
  result.targetLanguage = Object.hasOwn(LANGUAGES, input.targetLanguage) ? input.targetLanguage : DEFAULTS.targetLanguage;
  result.scope = input.scope === "viewport" ? "viewport" : "page";
  result.concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(Number(input.concurrency) || DEFAULTS.concurrency)));
  result.dynamic = input.dynamic !== false;
  result.glossary = String(input.glossary || "").trim().slice(0, 6000);
  return result;
}

export function publicSettings(settings) {
  const {apiKey, ...rest} = settings;
  return {...rest, hasApiKey: Boolean(apiKey)};
}
