import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertGraphInvariants } from "./core/graph.js";
import { GitAdapter } from "./core/git.js";
import { ConfigError, configWithSources, loadConfig, resolveConfigPaths, setUserGlobalConfigValue, type PartialCcflowConfig } from "./core/config.js";
import { initCcflowProject, resolveRepository, RepositoryError } from "./core/repo.js";
import { statePath } from "./core/storage.js";
import { renderPromptInspection } from "./core/prompts.js";
import { assertSupportedNodeVersion, assertTuiRuntimeAvailable, runCcflowApp, type RunAppOptions } from "./app.js";
import { runNodeSessionInCurrentTerminal } from "./core/node-session.js";

export interface CliIO {
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
}

export interface RunCliOptions extends CliIO {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  startTui?: RunAppOptions["startTui"];
}

interface ParsedArgs {
  command: string | null;
  positionals: string[];
  repoPath?: string;
  autoInit?: boolean;
  help: boolean;
  version: boolean;
  gitInit: boolean;
  force: boolean;
  global: boolean;
  nodeId?: string;
  cliConfig: PartialCcflowConfig;
}

export async function runCli(argv = process.argv.slice(2), options: RunCliOptions = {}): Promise<number> {
  const out = options.stdout ?? ((value: string) => console.log(value));
  const err = options.stderr ?? ((value: string) => console.error(value));
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const parsed = parseArgs(argv);

  try {
    if (parsed.version) {
      out(readPackageVersion());
      return 0;
    }
    if (parsed.help) {
      out(helpText());
      return 0;
    }

    switch (parsed.command) {
      case null:
        await runCcflowApp({
          cwd,
          repoPath: parsed.repoPath,
          autoInit: parsed.autoInit,
          cliConfig: parsed.cliConfig,
          startTui: options.startTui,
        });
        return 0;
      case "init":
        return runInit(parsed, cwd, out, env);
      case "doctor":
        return runDoctor(parsed, cwd, out, env);
      case "config":
        return runConfig(parsed, cwd, out, env);
      case "__node-session":
        return runInternalNodeSession(parsed, cwd, env);
      default:
        err(`Unknown command: ${parsed.command}\n\n${helpText()}`);
        return 1;
    }
  } catch (error) {
    err(formatError(error));
    return 1;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: null,
    positionals: [],
    help: false,
    version: false,
    gitInit: false,
    force: false,
    global: false,
    cliConfig: {},
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      parsed.version = true;
      continue;
    }
    if (arg === "--repo") {
      parsed.repoPath = requireValue(argv, ++index, "--repo");
      continue;
    }
    if (arg === "--no-auto-init") {
      parsed.autoInit = false;
      parsed.cliConfig.startup = { autoInit: false };
      continue;
    }
    if (arg === "--git") {
      parsed.gitInit = true;
      continue;
    }
    if (arg === "--force") {
      parsed.force = true;
      continue;
    }
    if (arg === "--global") {
      parsed.global = true;
      continue;
    }
    if (arg === "--claude-bin") {
      parsed.cliConfig.claude = { ...(parsed.cliConfig.claude ?? {}), bin: requireValue(argv, ++index, "--claude-bin") };
      continue;
    }
    if (arg === "--model") {
      parsed.cliConfig.claude = { ...(parsed.cliConfig.claude ?? {}), model: requireValue(argv, ++index, "--model") };
      continue;
    }
    if (arg === "--node") {
      parsed.nodeId = requireValue(argv, ++index, "--node");
      continue;
    }
    if (!parsed.command && !arg.startsWith("-")) {
      if (["init", "doctor", "config", "__node-session"].includes(arg)) parsed.command = arg;
      else parsed.repoPath = arg;
      continue;
    }
    parsed.positionals.push(arg);
  }
  return parsed;
}

function runInit(parsed: ParsedArgs, cwd: string, out: (value: string) => void, env: NodeJS.ProcessEnv): number {
  const repoPath = parsed.repoPath ?? parsed.positionals[0];
  const result = initCcflowProject({ startPath: cwd, repoPath, gitInit: parsed.gitInit });
  loadConfig({ repoRoot: result.repoRoot, cliOverrides: parsed.cliConfig, env });
  out(result.alreadyInitialized
    ? `CCFlow already initialized: ${result.stateFile}`
    : `Initialized CCFlow repository: ${result.repoRoot}\nState: ${result.stateFile}`);
  return 0;
}

async function runDoctor(parsed: ParsedArgs, cwd: string, out: (value: string) => void, env: NodeJS.ProcessEnv): Promise<number> {
  const lines: string[] = ["CCFlow doctor"];
  let warnings = 0;
  let errors = 0;
  const add = (status: "ok" | "warn" | "error", message: string): void => {
    if (status === "warn") warnings += 1;
    if (status === "error") errors += 1;
    lines.push(`[${status}] ${message}`);
  };

  try {
    assertSupportedNodeVersion();
    add("ok", `Node.js ${process.versions.node}`);
  } catch (error) {
    add("error", formatError(error));
  }

  const gitVersion = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (gitVersion.status === 0) add("ok", gitVersion.stdout.trim());
  else add("error", "Git is not available on PATH");

  try {
    await assertTuiRuntimeAvailable();
    add("ok", "OpenTUI runtime dependency is available");
  } catch (error) {
    add("error", formatError(error));
  }

  const repo = resolveRepository({ startPath: cwd, repoPath: parsed.repoPath });
  let repoRoot = repo.repoRoot ?? undefined;
  if (!repoRoot) {
    add("warn", "No Git repository found; repo-local checks skipped");
  } else {
    add("ok", `Repository: ${repoRoot}${repo.fromManagedWorktree ? " (managed worktree)" : ""}`);
    if (!repo.initialized) {
      add("warn", "Repository is not initialized for CCFlow");
    } else {
      try {
        const state = JSON.parse(fs.readFileSync(statePath(repoRoot), "utf8"));
        assertGraphInvariants(state);
        add("ok", "CCFlow state invariants are valid");
      } catch (error) {
        add("error", `Invalid CCFlow state: ${formatError(error)}`);
      }
    }
  }

  try {
    const loaded = loadConfig({ repoRoot, cliOverrides: parsed.cliConfig, env });
    add("ok", `Config valid (${loaded.files.length} file source${loaded.files.length === 1 ? "" : "s"})`);
    const promptSources = Object.keys(loaded.sources).filter((field) => field.startsWith("prompts."));
    add("ok", `Prompt config valid (${promptSources.length} attributed field${promptSources.length === 1 ? "" : "s"})`);
    repoRoot = repoRoot ?? undefined;
  } catch (error) {
    add("error", `Invalid config: ${formatError(error)}`);
  }

  const loadedGlobal = loadConfig({ repoRoot: undefined, env });
  const claude = spawnSync(loadedGlobal.config.claude.bin, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (claude.status === 0) add("ok", `Claude Code CLI detected via ${loadedGlobal.config.claude.bin}`);
  else add("warn", `Claude Code CLI not available via ${loadedGlobal.config.claude.bin}`);

  lines.push(`Summary: ${errors} error(s), ${warnings} warning(s)`);
  out(lines.join("\n"));
  return errors > 0 ? 1 : 0;
}

async function runInternalNodeSession(parsed: ParsedArgs, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  if (!parsed.nodeId) throw new Error("Usage: ccflow __node-session --repo <path> --node <node-id>");
  const repo = resolveRepository({ startPath: cwd, repoPath: parsed.repoPath });
  if (!repo.repoRoot) throw new RepositoryError("CCFlow node session requires a Git repository.");
  const loaded = loadConfig({ repoRoot: repo.repoRoot, cliOverrides: parsed.cliConfig, env });
  return runNodeSessionInCurrentTerminal({
    repoRoot: repo.repoRoot,
    nodeId: parsed.nodeId,
    config: loaded.config,
  });
}

function runConfig(parsed: ParsedArgs, cwd: string, out: (value: string) => void, env: NodeJS.ProcessEnv): number {
  const subcommand = parsed.positionals[0] ?? "show-effective";
  const repo = resolveRepository({ startPath: cwd, repoPath: parsed.repoPath });
  const repoRoot = repo.repoRoot ?? undefined;

  if (subcommand === "path") {
    const paths = resolveConfigPaths(repoRoot, env);
    out([
      `userGlobal: ${paths.userGlobalPath} (${exists(paths.userGlobalPath)})`,
      `xdgGlobal: ${paths.xdgGlobalPath} (${exists(paths.xdgGlobalPath)})`,
      `repoShared: ${paths.repoSharedPath ?? "(no repository)"} (${paths.repoSharedPath ? exists(paths.repoSharedPath) : "missing"})`,
      `repoLocal: ${paths.repoLocalPath ?? "(no repository)"} (${paths.repoLocalPath ? exists(paths.repoLocalPath) : "missing"})`,
    ].join("\n"));
    return 0;
  }

  if (subcommand === "show-effective" || subcommand === "get") {
    const loaded = loadConfig({ repoRoot, cliOverrides: parsed.cliConfig, env });
    out(JSON.stringify(configWithSources(loaded), null, 2));
    return 0;
  }

  if (subcommand === "set") {
    if (!parsed.global) throw new Error("Only `ccflow config set --global <field> <value>` is supported.");
    const field = parsed.positionals[1];
    const value = parsed.positionals.slice(2).join(" ");
    if (!field || !value) throw new Error("Usage: ccflow config set --global <field> <value>");
    const file = setUserGlobalConfigValue(field, value, env);
    loadConfig({ repoRoot, env });
    out(`Updated ${file}`);
    return 0;
  }

  if (subcommand === "prompt") {
    const kind = parsed.positionals[1];
    if (kind !== "commit" && kind !== "merge") throw new Error("Usage: ccflow config prompt <commit|merge>");
    const loaded = loadConfig({ repoRoot, cliOverrides: parsed.cliConfig, env });
    out(renderPromptInspection(kind, loaded));
    return 0;
  }

  throw new Error(`Unknown config command: ${subcommand}`);
}

function helpText(): string {
  return [
    "Usage:",
    "  ccflow [--repo <path>] [--no-auto-init]",
    "  ccflow init [path] [--git] [--force]",
    "  ccflow doctor [--repo <path>]",
    "  ccflow config path [--repo <path>]",
    "  ccflow config show-effective [--repo <path>]",
    "  ccflow config set --global <field> <value>",
    "  ccflow config prompt <commit|merge> [--repo <path>]",
    "  ccflow --help",
    "  ccflow --version",
  ].join("\n");
}

function readPackageVersion(): string {
  const dir = path.dirname(filePathFromImportMeta());
  const packagePath = [path.resolve(dir, "..", "package.json"), path.resolve(dir, "..", "..", "package.json")]
    .find((candidate) => fs.existsSync(candidate));
  if (!packagePath) throw new Error("Unable to locate package.json for version output");
  return JSON.parse(fs.readFileSync(packagePath, "utf8")).version as string;
}

function filePathFromImportMeta(): string {
  return fileURLToPath(import.meta.url);
}

function formatError(error: unknown): string {
  if (error instanceof ConfigError) return error.diagnostics.join("\n");
  if (error instanceof RepositoryError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function exists(file: string): string {
  return fs.existsSync(file) ? "exists" : "missing";
}
