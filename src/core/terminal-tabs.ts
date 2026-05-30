import fs from "node:fs";
import path from "node:path";
import { spawnSync as defaultSpawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { splitShellWords } from "./config.js";

export type TerminalAppId =
  | "ghostty"
  | "iterm2"
  | "terminal-app"
  | "wezterm"
  | "kitty"
  | "windows-terminal"
  | "gnome-terminal"
  | "konsole"
  | "xfce4-terminal"
  | "alacritty"
  | "xterm"
  | "x-terminal-emulator";
export type SupportedTerminalApp = TerminalAppId;
export type TerminalLaunchTarget = "tab" | "window";

export interface TerminalTabRequest {
  command: string;
  cwd: string;
  title?: string;
}

export interface OpenTerminalTabResult {
  terminal: TerminalAppId;
  terminalName?: string;
  target?: TerminalLaunchTarget;
}

export interface OpenTerminalTabDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnSync?: TerminalSpawnSync;
}

export interface NodeSessionCommandInput {
  repoRoot: string;
  nodeId: string;
  ccflowCommand?: string[];
  claudeBin?: string;
  model?: string;
}

export type TerminalSpawnResult = Pick<SpawnSyncReturns<string>, "status" | "stderr" | "error">;
export type TerminalSpawnSync = (command: string, args: string[]) => TerminalSpawnResult;

interface TerminalLaunchPlan {
  terminal: TerminalAppId;
  terminalName: string;
  target: TerminalLaunchTarget;
  command: string;
  args: string[];
}

export function detectTerminalApp(env: NodeJS.ProcessEnv = process.env): TerminalAppId | null {
  const forced = normalizeTerminalApp(env.CCFLOW_TERMINAL_APP);
  if (forced) return forced;

  const termProgram = env.TERM_PROGRAM?.toLowerCase() ?? "";
  if (termProgram.includes("iterm")) return "iterm2";
  if (termProgram.includes("ghostty")) return "ghostty";
  if (termProgram.includes("apple_terminal")) return "terminal-app";
  if (termProgram.includes("wezterm")) return "wezterm";
  if (termProgram.includes("kitty")) return "kitty";
  if (env.GHOSTTY_RESOURCES_DIR || env.GHOSTTY_BIN_DIR) return "ghostty";
  if (env.WEZTERM_PANE || env.WEZTERM_EXECUTABLE) return "wezterm";
  if (env.KITTY_WINDOW_ID || env.KITTY_LISTEN_ON || env.TERM === "xterm-kitty") return "kitty";
  if (env.WT_SESSION) return "windows-terminal";
  if (env.KONSOLE_VERSION) return "konsole";
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
  return args.map((arg) => quoteCommandArg(arg)).join(" ");
}

export function openTerminalTab(
  request: TerminalTabRequest,
  deps: OpenTerminalTabDeps = {},
): OpenTerminalTabResult {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const forced = normalizeTerminalApp(env.CCFLOW_TERMINAL_APP);
  if (env.CCFLOW_TERMINAL_APP && !forced) {
    throw new Error(`Unsupported CCFLOW_TERMINAL_APP value "${env.CCFLOW_TERMINAL_APP}". Supported terminals: ${SUPPORTED_TERMINAL_LABELS}.`);
  }

  const plans = buildTerminalLaunchPlans(request, {
    env,
    forced,
    platform,
  });
  if (plans.length === 0) {
    throw new Error(`Unsupported terminal for CCFlow MultiTab. Supported terminals: ${SUPPORTED_TERMINAL_LABELS}.`);
  }

  const spawn = deps.spawnSync ?? ((command, args) => defaultSpawnSync(command, args, { encoding: "utf8" }));
  const errors: string[] = [];
  for (const plan of plans) {
    const result = spawn(plan.command, plan.args);
    if (!result.error && (result.status ?? 0) === 0) {
      return {
        terminal: plan.terminal,
        terminalName: plan.terminalName,
        target: plan.target,
      };
    }
    errors.push(formatLaunchFailure(plan, result));
  }

  throw new Error(`Failed to open CCFlow node in a terminal tab. ${errors.join(" ")}`);
}

export function terminalDisplayName(terminal: TerminalAppId): string {
  switch (terminal) {
    case "ghostty": return "Ghostty";
    case "iterm2": return "iTerm2";
    case "terminal-app": return "Terminal.app";
    case "wezterm": return "WezTerm";
    case "kitty": return "kitty";
    case "windows-terminal": return "Windows Terminal";
    case "gnome-terminal": return "GNOME Terminal";
    case "konsole": return "Konsole";
    case "xfce4-terminal": return "Xfce Terminal";
    case "alacritty": return "Alacritty";
    case "xterm": return "xterm";
    case "x-terminal-emulator": return "x-terminal-emulator";
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildTerminalLaunchPlans(
  request: TerminalTabRequest,
  options: {
    env: NodeJS.ProcessEnv;
    forced: TerminalAppId | null;
    platform: NodeJS.Platform;
  },
): TerminalLaunchPlan[] {
  const detected = options.forced ?? detectTerminalApp(options.env);
  const terminalIds = detected ? [detected] : fallbackTerminalIds(options.platform);
  return terminalIds.flatMap((terminal) => buildLaunchPlansForTerminal(terminal, request, options));
}

function buildLaunchPlansForTerminal(
  terminal: TerminalAppId,
  request: TerminalTabRequest,
  options: {
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
  },
): TerminalLaunchPlan[] {
  switch (terminal) {
    case "ghostty":
      return options.platform === "darwin"
        ? [appleScriptPlan(terminal, "tab", buildGhosttyTabAppleScript(request))]
        : [commandPlan(terminal, "window", "ghostty", ["--working-directory", request.cwd, "-e", ...unixShellCommandArgs(request, options.env)])];
    case "iterm2":
      return options.platform === "darwin"
        ? [appleScriptPlan(terminal, "tab", buildITerm2TabAppleScript(request))]
        : [];
    case "terminal-app":
      return options.platform === "darwin"
        ? [appleScriptPlan(terminal, "tab", buildTerminalAppTabAppleScript(request))]
        : [];
    case "wezterm":
      return [
        commandPlan(terminal, "tab", "wezterm", ["cli", "spawn", "--cwd", request.cwd, "--", ...unixShellCommandArgs(request, options.env)]),
        commandPlan(terminal, "window", "wezterm", ["start", "--cwd", request.cwd, "--", ...unixShellCommandArgs(request, options.env)]),
      ];
    case "kitty":
      return [
        commandPlan(terminal, "tab", "kitty", ["@", "launch", "--type=tab", "--cwd", request.cwd, ...titleArgs("--tab-title", request.title), "--", ...unixShellCommandArgs(request, options.env)]),
      ];
    case "windows-terminal":
      return [
        commandPlan(terminal, "tab", "wt", ["-w", "0", "new-tab", "--startingDirectory", request.cwd, ...titleArgs("--title", request.title), "cmd.exe", "/d", "/k", request.command]),
      ];
    case "gnome-terminal":
      return [
        commandPlan(terminal, "tab", "gnome-terminal", ["--tab", "--working-directory", request.cwd, ...titleArgs("--title", request.title), "--", ...unixShellCommandArgs(request, options.env)]),
      ];
    case "konsole":
      return [
        commandPlan(terminal, "tab", "konsole", ["--new-tab", "--workdir", request.cwd, ...konsoleTitleArgs(request.title), "-e", ...unixShellCommandArgs(request, options.env)]),
      ];
    case "xfce4-terminal":
      return [
        commandPlan(terminal, "tab", "xfce4-terminal", ["--tab", "--working-directory", request.cwd, ...titleArgs("--title", request.title), "--command", request.command]),
      ];
    case "alacritty":
      return [
        commandPlan(terminal, "window", "alacritty", ["--working-directory", request.cwd, "-e", ...unixShellCommandArgs(request, options.env)]),
      ];
    case "xterm":
      return [
        commandPlan(terminal, "window", "xterm", [...titleArgs("-T", request.title), "-e", ...unixShellCommandArgs(request, options.env)]),
      ];
    case "x-terminal-emulator":
      return [
        commandPlan(terminal, "window", "x-terminal-emulator", ["-e", ...unixShellCommandArgs(request, options.env)]),
      ];
  }
}

function buildITerm2TabAppleScript(request: TerminalTabRequest): string {
  const command = `cd ${shellQuote(request.cwd)} && ${request.command}`;
  const commandLiteral = appleScriptString(command);
  const titleLiteral = appleScriptString(request.title ?? "CCFlow node");
  return [
    'tell application id "com.googlecode.iterm2"',
    "  activate",
    "  if (count of windows) = 0 then",
    "    set newWindow to (create window with default profile)",
    "    set newSession to current session of newWindow",
    "  else",
    "    tell current window",
    "      create tab with default profile",
    "      set newSession to current session",
    "    end tell",
    "  end if",
    "  tell newSession",
    `    set name to ${titleLiteral}`,
    `    write text ${commandLiteral}`,
    "  end tell",
    "end tell",
  ].join("\n");
}

function buildGhosttyTabAppleScript(request: TerminalTabRequest): string {
  const commandLiteral = appleScriptString(request.command);
  const cwdLiteral = appleScriptString(request.cwd);
  return [
    'tell application "Ghostty"',
    "  activate",
    "  set cfg to new surface configuration",
    `  set initial working directory of cfg to ${cwdLiteral}`,
    `  set initial input of cfg to ${commandLiteral} & linefeed`,
    "  if (count of windows) = 0 then",
    "    set w to new window with configuration cfg",
    "  else",
    "    set w to front window",
    "    new tab in w with configuration cfg",
    "  end if",
    "end tell",
  ].join("\n");
}

function buildTerminalAppTabAppleScript(request: TerminalTabRequest): string {
  const command = `cd ${shellQuote(request.cwd)} && ${request.command}`;
  const commandLiteral = appleScriptString(command);
  const titleLiteral = appleScriptString(request.title ?? "CCFlow node");
  return [
    'tell application "Terminal"',
    "  activate",
    "  if (count of windows) = 0 then",
    `    set newTab to (do script ${commandLiteral})`,
    "  else",
    '    tell application "System Events" to keystroke "t" using command down',
    `    set newTab to (do script ${commandLiteral} in selected tab of front window)`,
    "  end if",
    `  set custom title of newTab to ${titleLiteral}`,
    "end tell",
  ].join("\n");
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function appleScriptPlan(terminal: TerminalAppId, target: TerminalLaunchTarget, script: string): TerminalLaunchPlan {
  return commandPlan(terminal, target, "osascript", ["-e", script]);
}

function commandPlan(
  terminal: TerminalAppId,
  target: TerminalLaunchTarget,
  command: string,
  args: string[],
): TerminalLaunchPlan {
  return {
    terminal,
    terminalName: terminalDisplayName(terminal),
    target,
    command,
    args,
  };
}

function fallbackTerminalIds(platform: NodeJS.Platform): TerminalAppId[] {
  if (platform === "darwin") {
    return ["ghostty", "iterm2", "terminal-app", "wezterm", "kitty", "alacritty"];
  }
  if (platform === "win32") {
    return ["windows-terminal"];
  }
  return ["wezterm", "kitty", "gnome-terminal", "konsole", "xfce4-terminal", "alacritty", "x-terminal-emulator", "xterm"];
}

function normalizeTerminalApp(value?: string): TerminalAppId | null {
  if (!value) return null;
  const normalized = value.toLowerCase().replace(/[\s_]+/g, "-");
  switch (normalized) {
    case "ghostty":
      return "ghostty";
    case "iterm":
    case "iterm2":
    case "iterm.app":
      return "iterm2";
    case "terminal":
    case "terminal.app":
    case "apple-terminal":
    case "apple-terminal.app":
      return "terminal-app";
    case "wezterm":
      return "wezterm";
    case "kitty":
      return "kitty";
    case "windows-terminal":
    case "wt":
    case "wt.exe":
      return "windows-terminal";
    case "gnome-terminal":
    case "gnome":
      return "gnome-terminal";
    case "konsole":
      return "konsole";
    case "xfce":
    case "xfce4-terminal":
      return "xfce4-terminal";
    case "alacritty":
      return "alacritty";
    case "xterm":
      return "xterm";
    case "x-terminal-emulator":
      return "x-terminal-emulator";
    default:
      return null;
  }
}

function unixShellCommandArgs(request: TerminalTabRequest, env: NodeJS.ProcessEnv): string[] {
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : "/bin/sh";
  return [shell, "-lc", request.command];
}

function titleArgs(flag: string, title?: string): string[] {
  return title ? [flag, title] : [];
}

function konsoleTitleArgs(title?: string): string[] {
  return title ? ["-p", `tabtitle=${title}`] : [];
}

function quoteCommandArg(value: string): string {
  return process.platform === "win32" ? cmdQuote(value) : shellQuote(value);
}

function cmdQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function formatLaunchFailure(plan: TerminalLaunchPlan, result: TerminalSpawnResult): string {
  const detail = result.error
    ? result.error.message
    : (result.stderr ?? "").trim() || `exit status ${result.status ?? "unknown"}`;
  return `${plan.terminalName}: ${detail}.`;
}

const SUPPORTED_TERMINAL_LABELS = [
  "Ghostty",
  "iTerm2",
  "Terminal.app",
  "WezTerm",
  "kitty",
  "Windows Terminal",
  "GNOME Terminal",
  "Konsole",
  "Xfce Terminal",
  "Alacritty",
  "xterm",
].join(", ");
