import {mkdir, writeFile} from "node:fs/promises";
import {performance} from "node:perf_hooks";
import {fileURLToPath} from "node:url";
import {requestTranslation} from "../lib/api.js";
import {loadTestSettings} from "./test-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const settings = await loadTestSettings();
if (!settings.apiKey) throw new Error("Set DEEPSEEK_API_KEY or create an ignored local-config.json before running live tests.");
const blocks = [
  {id: "heading", parts: ["A quieter way to read the web"]},
  {id: "inline", parts: ["Read the ", "original paper", " for details about the ", "electro-optic frequency comb", "."]},
  {id: "science", parts: ["The measured linewidth was 12 kHz at a temperature of 300 K. The cavity resonance shifts when the applied voltage changes."]},
];
const start = performance.now();
const result = await requestTranslation(blocks, settings, {signal: AbortSignal.timeout(60000), title: "Translation integration test"});
const report = {testedAt: new Date().toISOString(), model: settings.model, elapsedSeconds: Number(((performance.now() - start) / 1000).toFixed(2)), source: blocks, ...result};
await mkdir(`${root}/test-results`, {recursive: true});
await writeFile(`${root}/test-results/live-api.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
