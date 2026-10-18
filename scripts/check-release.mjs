import {execFileSync} from "node:child_process";
import {readFile} from "node:fs/promises";

const git = (...args) => execFileSync("git", args, {maxBuffer: 16 * 1024 * 1024});
const paths = git("ls-files", "-z").toString().split("\0").filter(Boolean);
const problems = [];
let localKey = process.env.DEEPSEEK_API_KEY || "";
try {
  const local = JSON.parse(await readFile(new URL("../local-config.json", import.meta.url), "utf8"));
  localKey ||= local.apiKey || "";
} catch (error) { if (error.code !== "ENOENT") throw error; }

function scan(data, name) {
  if (localKey && data.includes(Buffer.from(localKey))) problems.push(`${name}: local API key found`);
  if (/\bsk-[A-Za-z0-9_-]{24,}\b/.test(data.toString("utf8"))) problems.push(`${name}: credential-shaped value found`);
}

for (const path of paths) {
  if (path === "local-config.json" || /^(?:test-results|node_modules|\.browser-profile)\//.test(path)
    || /^\.env(?:\.|$)/.test(path) && path !== ".env.example") problems.push(`${path}: local-only file is tracked`);
  scan(git("show", `:${path}`), path);
}

let objects = 0;
if (process.argv.includes("--history")) {
  const entries = git("rev-list", "--objects", "--all").toString().trim().split("\n").filter(Boolean);
  for (const entry of entries) {
    const [oid, ...name] = entry.split(" ");
    scan(git("cat-file", "-p", oid), name.join(" ") || oid.slice(0, 12));
    objects++;
  }
}

if (problems.length) {
  console.error([...new Set(problems)].join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Release audit passed: ${paths.length} indexed files${objects ? ` and ${objects} Git objects` : ""}; no local configuration or API keys found.`);
}
