#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const thisFile = fileURLToPath(import.meta.url);
const packageRoot = dirname(dirname(thisFile));
const entry = join(packageRoot, "dist", "main.js");

if (!process.versions.bun && process.env.CCFLOW_BUN_BOOTSTRAP !== "0") {
  const result = spawnSync("bun", [entry, ...process.argv.slice(2)], {
    env: { ...process.env, CCFLOW_BUN_BOOTSTRAP: "0" },
    stdio: "inherit",
  });

  if (!result.error) {
    if (result.signal) {
      process.kill(process.pid, result.signal);
    }
    process.exit(result.status ?? 1);
  }
}

await import("../dist/main.js");
