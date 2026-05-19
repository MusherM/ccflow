import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { CcflowNode } from "./types.js";
import { runCommand, tryCommand } from "./shell.js";
import { releaseStdinForChildProcess, resetTerminalForChildProcess } from "./terminal.js";

function safeSessionName(nodeId: string): string {
  return `ccflow_${nodeId.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 80)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandFor(node: CcflowNode): string {
  const claudeBin = process.env.CCFLOW_CLAUDE_BIN ?? "claude";
  if (node.cc.sessionId && node.cc.resumeMode === "resume") {
    return `${claudeBin} --resume ${shellQuote(node.cc.sessionId)}`;
  }
  return claudeBin;
}

export class ClaudeAdapter {
  attachOrResume(node: CcflowNode, cwd: string): { sessionId: string | null; tmuxSession: string | null; alive: boolean } {
    const tmuxSession = node.cc.tmuxSession || safeSessionName(node.id);
    if (!this.hasTmuxSession(tmuxSession)) {
      this.prepareTmuxDefaults();
      runCommand("tmux", ["new-session", "-d", "-s", tmuxSession, "-c", cwd, commandFor(node)]);
      node.cc.tmuxSession = tmuxSession;
      node.cc.resumeMode = node.cc.sessionId ? "resume" : "new";
    }

    this.attachTmux(tmuxSession);
    const alive = this.hasTmuxSession(tmuxSession);
    const sessionId = this.findRecentClaudeSessionId(cwd) ?? node.cc.sessionId;
    return { sessionId, tmuxSession: alive ? tmuxSession : null, alive };
  }

  runHeadless(prompt: string, cwd: string): { ok: boolean; stdout: string; stderr: string } {
    if (process.env.CCFLOW_DISABLE_CLAUDE_JOBS === "1") {
      return { ok: false, stdout: "", stderr: "Claude jobs are disabled by CCFLOW_DISABLE_CLAUDE_JOBS." };
    }

    const claudeBin = process.env.CCFLOW_CLAUDE_BIN ?? "claude";
    const extraArgs = splitShellWords(process.env.CCFLOW_CLAUDE_ARGS ?? "");
    const result = spawnSync(claudeBin, [...extraArgs, "-p", prompt], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      env: process.env,
    });
    if (result.error) {
      return { ok: false, stdout: result.stdout ?? "", stderr: result.error.message };
    }
    return {
      ok: (result.status ?? 0) === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  hasTmuxSession(session: string): boolean {
    return tryCommand("tmux", ["has-session", "-t", session]).ok;
  }

  private attachTmux(session: string): void {
    const previousEscape = this.captureTmuxBinding();
    const previousEscapeTime = this.captureEscapeTime();
    this.prepareTmuxSession(session);
    tryCommand("tmux", ["bind-key", "-T", "root", "Escape", "detach-client"]);
    tryCommand("tmux", ["set-option", "-s", "escape-time", process.env.CCFLOW_TMUX_ESCAPE_TIME ?? "500"]);
    releaseStdinForChildProcess();
    resetTerminalForChildProcess();
    try {
      spawnSync("tmux", ["-u", "-2", "attach-session", "-t", session], {
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
    } finally {
      this.restoreTmuxBinding(previousEscape);
      if (previousEscapeTime !== null) tryCommand("tmux", ["set-option", "-s", "escape-time", previousEscapeTime]);
    }
  }

  private prepareTmuxDefaults(): void {
    tryCommand("tmux", ["set-option", "-g", "default-terminal", "screen-256color"]);
    tryCommand("tmux", ["set-option", "-ga", "terminal-overrides", ",*:Tc"]);
    tryCommand("tmux", ["set-option", "-as", "terminal-features", ",*:RGB"]);
  }

  private prepareTmuxSession(session: string): void {
    this.prepareTmuxDefaults();
    tryCommand("tmux", ["set-option", "-t", session, "status", "off"]);
    tryCommand("tmux", ["set-window-option", "-t", session, "aggressive-resize", "on"]);
  }

  private captureTmuxBinding(): string | null {
    const result = tryCommand("tmux", ["list-keys", "-T", "root", "Escape"]);
    return result.ok ? result.stdout.trim() : null;
  }

  private restoreTmuxBinding(previous: string | null): void {
    tryCommand("tmux", ["unbind-key", "-T", "root", "Escape"]);
    if (!previous) return;
    for (const line of previous.split(/\r?\n/).filter(Boolean)) {
      const args = splitShellWords(line);
      if (args[0] === "bind-key") tryCommand("tmux", args);
    }
  }

  private captureEscapeTime(): string | null {
    const result = tryCommand("tmux", ["show-options", "-s", "-v", "escape-time"]);
    return result.ok ? result.stdout.trim() : null;
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
