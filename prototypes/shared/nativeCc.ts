import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrototypeNode } from "./nodes.js";

const helperPath = resolve(dirname(fileURLToPath(import.meta.url)), "cc_pty.py");

export function runNativeCc(node: PrototypeNode): Promise<number> {
  return Promise.resolve().then(() => {
    const python = process.env.PYTHON ?? "python3";
    const result = spawnSync(python, [helperPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CCFLOW_NODE_ID: node.id,
        CCFLOW_NODE_TITLE: node.title,
        CCFLOW_NODE_BRANCH: node.branch,
      },
      stdio: "inherit",
    });

    if (result.error) {
      process.stderr.write(`Failed to start PTY helper: ${result.error.message}\n`);
      return 1;
    }

    return result.status ?? 0;
  });
}
