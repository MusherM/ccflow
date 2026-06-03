import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export interface ClaudeCliConfig {
  binPath: string;
  env: NodeJS.ProcessEnv;
}

let claudeSettingsPath: string | null = null;
let initialClaudeSettings: string | null = null;
let cleanupRegistered = false;

export function claudeCliConfig(): ClaudeCliConfig {
  if (process.env.CCFLOW_TEST_SKIP_REAL_CC === "1") {
    throw new Error("real Claude Code tests skipped by --skip-real-cc");
  }

  const env = ensureClaudeTestHome();
  restoreClaudeSettings();
  const candidate = process.env.CCFLOW_CLAUDE_BIN ?? "claude";
  const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5000 });
  restoreClaudeSettings();
  const versionOutput = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  if (probe.status !== 0 || !/Claude Code/i.test(versionOutput)) {
    throw new Error(`${candidate} is not a Claude Code CLI; set CCFLOW_CLAUDE_BIN to the real claude/cc binary`);
  }

  const args = process.env.CCFLOW_CLAUDE_ARGS ?? "--permission-mode bypassPermissions --max-budget-usd 1";
  return {
    binPath: candidate,
    env: {
      ...env,
      CCFLOW_CLAUDE_BIN: candidate,
      CCFLOW_CLAUDE_ARGS: args,
    },
  };
}

export async function withClaudeCliEnv<T>(config: ClaudeCliConfig, fn: () => T | Promise<T>): Promise<T> {
  const previous = snapshotEnv([
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "CCFLOW_CONFIG",
    "CCFLOW_TEST_HOME",
    "CCFLOW_REAL_HOME",
    "CCFLOW_CLAUDE_BIN",
    "CCFLOW_CLAUDE_ARGS",
    "CCFLOW_TEST_REAL_CC_CACHE",
    "CCFLOW_TEST_SKIP_REAL_CC",
    "CCFLOW_TEST_FORCE_REAL_CC",
  ]);
  restoreClaudeSettings();
  applyEnv(config.env);
  try {
    return await fn();
  } finally {
    restoreClaudeSettings();
    restoreEnvSnapshot(previous);
  }
}

export function withClaudeSettingsSnapshot<T>(fn: () => T): T {
  ensureClaudeTestHome();
  restoreClaudeSettings();
  try {
    return fn();
  } finally {
    restoreClaudeSettings();
  }
}

export function realClaudePromptGate(name: string, prompt: string): {
  shouldRun: boolean;
  reason: string;
  promptHash: string;
  markPassed: () => void;
} {
  const promptHash = hashPrompt(prompt);
  if (process.env.CCFLOW_TEST_FORCE_REAL_CC === "1") {
    return {
      shouldRun: true,
      reason: `forced real Claude Code test for ${name}`,
      promptHash,
      markPassed: () => markRealClaudePromptPassed(name, promptHash),
    };
  }

  const cache = readRealClaudeCache();
  const entry = cache.entries[name];
  if (entry?.promptHash === promptHash) {
    return {
      shouldRun: false,
      reason: `real Claude Code post-prompt layer already passed for unchanged prompt ${promptHash.slice(0, 12)}`,
      promptHash,
      markPassed: () => {},
    };
  }

  return {
    shouldRun: true,
    reason: `real Claude Code prompt changed or has no cache for ${name}`,
    promptHash,
    markPassed: () => markRealClaudePromptPassed(name, promptHash),
  };
}

export function requirePython3(): void {
  const result = spawnSync("python3", ["--version"], { encoding: "utf8", timeout: 3000 });
  if (result.status !== 0) {
    throw new Error("python3 is required for TUI smoke tests");
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function restoreClaudeSettings(): void {
  if (!claudeSettingsPath) return;
  if (initialClaudeSettings === null) {
    if (fs.existsSync(claudeSettingsPath)) {
      fs.unlinkSync(claudeSettingsPath);
    }
    return;
  }

  const current = fs.existsSync(claudeSettingsPath)
    ? fs.readFileSync(claudeSettingsPath, "utf8")
    : null;
  if (current === initialClaudeSettings) return;

  fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
  fs.writeFileSync(claudeSettingsPath, initialClaudeSettings);
}

function ensureClaudeTestHome(): NodeJS.ProcessEnv {
  const existing = process.env.CCFLOW_TEST_HOME;
  if (existing) {
    captureClaudeSettings(existing);
    return process.env;
  }

  const realHome = process.env.CCFLOW_REAL_HOME ?? os.homedir();
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-claude-home-"));
  const fakeXdgHome = path.join(fakeHome, ".config");
  const fakeCcflowConfig = path.join(fakeHome, ".ccflowrc");
  const preserved = snapshotEnv([
    "CCFLOW_CLAUDE_BIN",
    "CCFLOW_CLAUDE_ARGS",
    "CCFLOW_TEST_REAL_CC_CACHE",
    "CCFLOW_TEST_SKIP_REAL_CC",
    "CCFLOW_TEST_FORCE_REAL_CC",
  ]);

  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CCFLOW_")) delete process.env[key];
  }
  for (const [name, value] of Object.entries(preserved)) {
    restoreEnv(name, value);
  }

  fs.mkdirSync(fakeXdgHome, { recursive: true });
  copyClaudeSettings(realHome, fakeHome);
  registerFakeHomeCleanup(fakeHome);

  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.XDG_CONFIG_HOME = fakeXdgHome;
  process.env.CCFLOW_CONFIG = fakeCcflowConfig;
  process.env.CCFLOW_TEST_HOME = fakeHome;
  process.env.CCFLOW_REAL_HOME = realHome;

  captureClaudeSettings(fakeHome);
  return process.env;
}

function captureClaudeSettings(home: string): void {
  if (claudeSettingsPath) return;
  claudeSettingsPath = path.join(home, ".claude", "settings.json");
  initialClaudeSettings = fs.existsSync(claudeSettingsPath)
    ? fs.readFileSync(claudeSettingsPath, "utf8")
    : null;
}

function copyClaudeSettings(sourceHome: string, targetHome: string): void {
  const source = path.join(sourceHome, ".claude", "settings.json");
  if (!fs.existsSync(source)) return;
  const target = path.join(targetHome, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function snapshotEnv(names: string[]): Record<string, string | undefined> {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function applyEnv(env: NodeJS.ProcessEnv): void {
  for (const name of [
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "CCFLOW_CONFIG",
    "CCFLOW_TEST_HOME",
    "CCFLOW_REAL_HOME",
    "CCFLOW_CLAUDE_BIN",
    "CCFLOW_CLAUDE_ARGS",
    "CCFLOW_TEST_REAL_CC_CACHE",
    "CCFLOW_TEST_SKIP_REAL_CC",
    "CCFLOW_TEST_FORCE_REAL_CC",
  ]) {
    restoreEnv(name, env[name]);
  }
}

function restoreEnvSnapshot(snapshot: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(snapshot)) {
    restoreEnv(name, value);
  }
}

function registerFakeHomeCleanup(fakeHome: string): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once("exit", () => {
    try {
      fs.rmSync(fakeHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Best-effort cleanup only. A transient temp file should not mask test results.
    }
  });
}

interface RealClaudeCache {
  version: 1;
  entries: Record<string, { promptHash: string; passedAt: string }>;
}

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function readRealClaudeCache(): RealClaudeCache {
  const file = process.env.CCFLOW_TEST_REAL_CC_CACHE;
  if (!file || !fs.existsSync(file)) return { version: 1, entries: {} };

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RealClaudeCache;
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") return parsed;
  } catch {
    // Ignore corrupt cache files; the real test will run and rewrite the marker.
  }
  return { version: 1, entries: {} };
}

function markRealClaudePromptPassed(name: string, promptHash: string): void {
  const file = process.env.CCFLOW_TEST_REAL_CC_CACHE;
  if (!file) return;

  const cache = readRealClaudeCache();
  cache.entries[name] = {
    promptHash,
    passedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
}
