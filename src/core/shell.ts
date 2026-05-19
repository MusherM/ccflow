import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

export interface CommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

type ShellOptions = Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> & {
  encoding?: BufferEncoding;
};

export function runCommand(
  command: string,
  args: string[],
  options: ShellOptions = {},
): string {
  const result = tryCommand(command, args, options);
  if (!result.ok) {
    const rendered = [command, ...args].join(" ");
    throw new Error(`${rendered} failed: ${result.stderr || result.stdout || result.code}`);
  }
  return result.stdout.trim();
}

export function tryCommand(
  command: string,
  args: string[],
  options: ShellOptions = {},
): CommandResult {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) {
    return {
      ok: false,
      code: null,
      stdout: result.stdout ?? "",
      stderr: result.error.message,
    };
  }
  const code = result.status ?? 0;
  return {
    ok: code === 0,
    code,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
