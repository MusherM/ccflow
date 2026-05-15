import { execFileSync, spawn } from "node:child_process";

export function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

export function tryRun(command: string, args: string[], options: { cwd?: string } = {}) {
  try {
    return { ok: true as const, stdout: run(command, args, options) };
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string };
    return {
      ok: false as const,
      stderr: err.stderr?.toString() ?? err.message ?? "Command failed"
    };
  }
}

export function spawnProcess(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"]
  });
}
