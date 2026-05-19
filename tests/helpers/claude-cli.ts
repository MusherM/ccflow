import { spawnSync } from "node:child_process";

export interface ClaudeCliConfig {
  binPath: string;
  env: NodeJS.ProcessEnv;
}

export function claudeCliConfig(): ClaudeCliConfig {
  const candidate = process.env.CCFLOW_CLAUDE_BIN ?? "claude";
  const probe = spawnSync(candidate, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const versionOutput = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  if (probe.status !== 0 || !/Claude Code/i.test(versionOutput)) {
    throw new Error(`${candidate} is not a Claude Code CLI; set CCFLOW_CLAUDE_BIN to the real claude/cc binary`);
  }

  const args = process.env.CCFLOW_CLAUDE_ARGS ?? "--permission-mode bypassPermissions --max-budget-usd 1";
  return {
    binPath: candidate,
    env: {
      ...process.env,
      CCFLOW_CLAUDE_BIN: candidate,
      CCFLOW_CLAUDE_ARGS: args,
    },
  };
}

export async function withClaudeCliEnv<T>(config: ClaudeCliConfig, fn: () => T | Promise<T>): Promise<T> {
  const previousBin = process.env.CCFLOW_CLAUDE_BIN;
  const previousArgs = process.env.CCFLOW_CLAUDE_ARGS;
  process.env.CCFLOW_CLAUDE_BIN = config.binPath;
  process.env.CCFLOW_CLAUDE_ARGS = config.env.CCFLOW_CLAUDE_ARGS;
  try {
    return await fn();
  } finally {
    restoreEnv("CCFLOW_CLAUDE_BIN", previousBin);
    restoreEnv("CCFLOW_CLAUDE_ARGS", previousArgs);
  }
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
