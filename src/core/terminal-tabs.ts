import fs from "node:fs";
import path from "node:path";
import { spawnSync as defaultSpawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { splitShellWords } from "./config.js";

export type SupportedTerminalApp = "iterm2" | "ghostty";

export interface TerminalTabRequest {
  command: string;
  cwd: string;
  title?: string;
}

export interface OpenTerminalTabResult {
  terminal: SupportedTerminalApp;
}

export interface OpenTerminalTabDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnSync?: (command: string, args: string[]) => Pick<SpawnSyncReturns<string>, "status" | "stderr" | "error">;
}

export interface NodeSessionCommandInput {
  repoRoot: string;
  nodeId: string;
  ccflowCommand?: string[];
  claudeBin?: string;
  model?: string;
}

export function detectTerminalApp(env: NodeJS.ProcessEnv = process.env): SupportedTerminalApp | null {
  const forced = env.CCFLOW_TERMINAL_APP?.toLowerCase();
  if (forced === "iterm2" || forced === "iterm" || forced === "iterm.app") return "iterm2";
  if (forced === "ghostty") return "ghostty";

  const termProgram = env.TERM_PROGRAM?.toLowerCase() ?? "";
  if (termProgram.includes("iterm")) return "iterm2";
  if (termProgram.includes("ghostty")) return "ghostty";
  if (env.GHOSTTY_RESOURCES_DIR || env.GHOSTTY_BIN_DIR) return "ghostty";
  return null;
}

export function currentCcflowCommand(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
  execPath = process.execPath,
): string[] {
  if (env.CCFLOW_SELF_COMMAND) return splitShellWords(env.CCFLOW_SELF_COMMAND);
  const script = argv[1];
  if (script && path.isAbsolute(script) && fs.existsSync(script)) return [execPath, script];
  return ["ccflow"];
}

export function resolveExecutable(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (path.isAbsolute(bin)) return bin;
  if (bin.includes("/")) return bin;
  const PATH = env.PATH ?? "";
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    try {
      const fullPath = path.join(dir, bin);
      if (fs.existsSync(fullPath)) return fullPath;
    } catch {
      // skip inaccessible directories
    }
  }
  return bin;
}

export function buildNodeSessionCommand(input: NodeSessionCommandInput): string {
  const args = [
    ...(input.ccflowCommand ?? currentCcflowCommand()),
    "__node-session",
    "--repo",
    input.repoRoot,
    "--node",
    input.nodeId,
  ];
  if (input.claudeBin) args.push("--claude-bin", resolveExecutable(input.claudeBin));
  if (input.model) args.push("--model", input.model);
  return args.map(shellQuote).join(" ");
}

export function openTerminalTab(
  request: TerminalTabRequest,
  deps: OpenTerminalTabDeps = {},
): OpenTerminalTabResult {
  const terminal = detectTerminalApp(deps.env);
  if (!terminal) {
    throw new Error("Unsupported terminal for CCFlow MultiTab. Supported terminals: iTerm2 and Ghostty.");
  }
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error("CCFlow MultiTab currently supports iTerm2 and Ghostty tab automation on macOS.");
  }

  const script = terminal === "iterm2"
    ? buildITerm2TabAppleScript(request)
    : buildGhosttyTabAppleScript(request);
  const spawn = deps.spawnSync ?? ((command, args) => defaultSpawnSync(command, args, { encoding: "utf8" }));
  const result = spawn("osascript", ["-e", script]);
  if (result.error) throw result.error;
  if ((result.status ?? 0) !== 0) {
    throw new Error((result.stderr ?? "").trim() || `Failed to open ${terminal} tab with osascript.`);
  }
  return { terminal };
}

export function buildITerm2TabAppleScript(request: TerminalTabRequest): string {
  const command = `cd ${shellQuote(request.cwd)} && ${request.command}`;
  const commandLiteral = appleScriptString(command);
  const titleLiteral = appleScriptString(request.title ?? "CCFlow node");
  return [
    'tell application "iTerm2"',
    "  activate",
    "  if (count of windows) = 0 then",
    `    create window with default profile command ${commandLiteral}`,
    "  else",
    "    tell current window",
    `      create tab with default profile command ${commandLiteral}`,
    "    end tell",
    "  end if",
    "  tell current session of current window",
    `    set name to ${titleLiteral}`,
    "  end tell",
    "end tell",
  ].join("\n");
}

export function buildGhosttyTabAppleScript(request: TerminalTabRequest): string {
  // Ghostty AppleScript API 的 command 属性会原样传递给 /bin/bash -c，
  // 不支持配置文件的 shell: 前缀语法（shell: 会泄漏到命令名中导致执行失败）。
  // 用 splitShellWords 将 shell-quoted 命令解析为原始参数后空格拼接，
  // Ghostty 自带命令行解析，无需 shell quoting。
  const rawCommand = splitShellWords(request.command).join(" ");
  const commandLiteral = appleScriptString(rawCommand);
  const cwdLiteral = appleScriptString(request.cwd);
  return [
    'tell application "Ghostty"',
    "  activate",
    "  set cfg to new surface configuration",
    `  set command of cfg to ${commandLiteral}`,
    `  set initial working directory of cfg to ${cwdLiteral}`,
    "  if (count of windows) = 0 then",
    "    set w to new window with configuration cfg",
    "    set t to selected tab of w",
    "  else",
    "    set w to front window",
    "    set t to new tab in w with configuration cfg",
    "  end if",
    "end tell",
  ].join("\n");
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
