import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { CcflowNode } from "./types.js";
import { logEvent } from "./log.js";
import { quarantineTerminalInput, releaseStdinForChildProcess, resetTerminalForChildProcess } from "./terminal.js";

/* node:coverage disable */
function interactiveCommandFor(node: CcflowNode): { bin: string; args: string[] } {
  const claudeBin = process.env.CCFLOW_CLAUDE_BIN ?? "claude";
  if (node.cc.sessionId && node.cc.resumeMode === "resume") {
    return { bin: claudeBin, args: ["--resume", node.cc.sessionId, "--dangerously-skip-permissions"] };
  }
  return { bin: claudeBin, args: ["--dangerously-skip-permissions"] };
}
/* node:coverage enable */

export class ClaudeAdapter {
  /* node:coverage disable */
  async attachOrResume(
    node: CcflowNode,
    cwd: string,
  ): Promise<{ sessionId: string | null; alive: boolean }> {
    const command = interactiveCommandFor(node);

    await quarantineTerminalInput();
    releaseStdinForChildProcess();
    resetTerminalForChildProcess();
    try {
      const result = spawnSync(command.bin, command.args, {
        cwd,
        stdio: "inherit",
        env: {
          ...process.env,
          TERM: process.env.TERM === "dumb" ? "xterm-256color" : (process.env.TERM ?? "xterm-256color"),
          CLICOLOR: "1",
          CLICOLOR_FORCE: "1",
          COLORTERM: "truecolor",
          FORCE_COLOR: "3",
        },
      });
      if (result.error) throw result.error;
    } finally {
      releaseStdinForChildProcess();
      resetTerminalForChildProcess();
    }

    const sessionId = this.findRecentClaudeSessionId(cwd) ?? node.cc.sessionId;
    return { sessionId, alive: false };
  }
  /* node:coverage enable */

  runHeadless(repoRoot: string, prompt: string, cwd: string): { ok: boolean; stdout: string; stderr: string } {
    if (process.env.CCFLOW_DISABLE_CLAUDE_JOBS === "1") {
      return { ok: false, stdout: "", stderr: "Claude jobs are disabled by CCFLOW_DISABLE_CLAUDE_JOBS." };
    }

    const claudeBin = process.env.CCFLOW_CLAUDE_BIN ?? "claude";
    const extraArgs = splitShellWords(process.env.CCFLOW_CLAUDE_ARGS ?? "");
    logEvent(repoRoot, "claude:headless:start", {
      bin: claudeBin,
      cwd,
      promptLength: prompt.length,
      promptPreview: prompt.slice(0, 500),
    });
    const result = spawnSync(claudeBin, [...extraArgs, "-p", prompt, "--permission-mode", "bypassPermissions", "--output-format", "json", "--model", "haiku"], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      env: process.env,
    });
    if (result.error) {
      logEvent(repoRoot, "claude:headless:error", {
        cwd,
        error: result.error.message,
      });
      return { ok: false, stdout: result.stdout ?? "", stderr: result.error.message };
    }
    logEvent(repoRoot, "claude:headless:done", {
      cwd,
      exitCode: result.status ?? null,
      signal: result.signal ?? null,
      stdoutLen: result.stdout?.length ?? 0,
      stderrLen: result.stderr?.length ?? 0,
      stdoutTail: (result.stdout ?? "").slice(-2000),
      stderrTail: (result.stderr ?? "").slice(-2000),
    });
    return {
      ok: (result.status ?? 0) === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  private findRecentClaudeSessionId(cwd: string): string | null {
    const root = path.join(os.homedir(), ".claude", "projects");
    if (!fs.existsSync(root)) return null;
    const projectDirs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const candidates = projectDirs
      .flatMap((entry) => {
        const dir = path.join(root, entry.name);
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((file) => file.isFile() && file.name.endsWith(".jsonl"))
          .map((file) => path.join(dir, file.name));
      })
      .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 20);

    for (const candidate of candidates) {
      const sessionId = readLastSessionId(candidate.file, cwd);
      if (sessionId) return sessionId;
    }
    return null;
  }
}

function readLastSessionId(file: string, cwd: string): string | null {
  try {
    const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).slice(-50).reverse();
    for (const line of lines) {
      const parsed = JSON.parse(line) as { sessionId?: string; cwd?: string };
      if (parsed.sessionId && (!parsed.cwd || path.resolve(parsed.cwd) === path.resolve(cwd))) {
        return parsed.sessionId;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function splitShellWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}
