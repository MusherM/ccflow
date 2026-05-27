#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const details = [];

if (await currentRuntimeCanLoadOpenTui()) {
  process.exit(0);
}

if (bunCanLoadOpenTui()) {
  process.exit(0);
}

process.stderr.write(
  [
    "CCFlow install failed: OpenTUI is not available in this environment.",
    "",
    "CCFlow does not provide a basic TUI fallback. Install Bun and make sure `bun` is on PATH,",
    "or use a Node.js build that can load node:ffi for @opentui/core.",
    "",
    ...details.map((detail) => `- ${detail}`),
    "",
  ].join("\n"),
);
process.exit(1);

async function currentRuntimeCanLoadOpenTui() {
  try {
    await import("@opentui/core");
    return true;
  } catch (error) {
    details.push(`current runtime cannot load @opentui/core: ${formatError(error)}`);
    return false;
  }
}

function bunCanLoadOpenTui() {
  const result = spawnSync("bun", ["-e", "await import('@opentui/core')"], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.status === 0) return true;

  if (result.error) {
    details.push(`bun runtime is not available: ${result.error.message}`);
    return false;
  }

  details.push(`bun runtime cannot load @opentui/core: ${formatOutput(result.stderr || result.stdout)}`);
  return false;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function formatOutput(value) {
  const trimmed = value.trim();
  return trimmed || "process exited without diagnostic output";
}
