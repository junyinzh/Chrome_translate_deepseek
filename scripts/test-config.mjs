import {readFile} from "node:fs/promises";
import {normalizeSettings} from "../lib/settings.js";

export async function loadTestSettings() {
  let local = {};
  try { local = JSON.parse(await readFile(new URL("../local-config.json", import.meta.url), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return normalizeSettings({...local, apiKey: process.env.DEEPSEEK_API_KEY || local.apiKey || ""});
}
