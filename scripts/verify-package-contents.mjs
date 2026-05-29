import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-pack-"));
const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--cache", path.join(temp, "cache")], {
  encoding: "utf8",
  stdio: "pipe",
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

const parsed = JSON.parse(result.stdout);
const files = parsed[0].files.map((file) => file.path).sort();
const requiredPrefixes = ["bin/", "dist/"];
const requiredFiles = ["package.json", "README.md", "README_zh.md", "LICENSE", "assets/ccflow-intro.png", "assets/ccflow-logo.png", "assets/ccflow-tui-node-graph.png", "scripts/verify-opentui-runtime.mjs"];
const allowedScriptFiles = new Set(["scripts/verify-opentui-runtime.mjs"]);
const forbiddenPrefixes = ["src/", "tests/", "node_modules/", ".ccflow/", ".claude/", ".codex/", "openspec/", "prototypes/", "scratch/", "dist-test/"];
const forbiddenFiles = ["nohup.out"];

const failures = [];
for (const required of requiredFiles) {
  if (!files.includes(required)) failures.push(`missing required file ${required}`);
}
for (const prefix of requiredPrefixes) {
  if (!files.some((file) => file.startsWith(prefix))) failures.push(`missing required prefix ${prefix}`);
}
for (const file of files) {
  if (forbiddenFiles.includes(file)) failures.push(`forbidden file included: ${file}`);
  if (file.startsWith("scripts/") && !allowedScriptFiles.has(file)) failures.push(`forbidden script included: ${file}`);
  if (forbiddenPrefixes.some((prefix) => file.startsWith(prefix))) failures.push(`forbidden path included: ${file}`);
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Package content verification passed (${files.length} files).\n`);
