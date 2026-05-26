import { GitAdapter } from "./core/git.js";
import { loadConfig, type CcflowConfig, type PartialCcflowConfig } from "./core/config.js";
import { isCcflowInitialized, initCcflowProject, loadInitializedState, resolveRepository, RepositoryError } from "./core/repo.js";
import { saveState } from "./core/storage.js";
import type { CcflowState } from "./core/types.js";

export interface RunAppOptions {
  cwd?: string;
  repoPath?: string;
  autoInit?: boolean;
  nodeVersion?: string;
  cliConfig?: PartialCcflowConfig;
  startTui?: (state: CcflowState, options: { config: CcflowConfig }) => Promise<void>;
}

export async function runCcflowApp(options: RunAppOptions = {}): Promise<void> {
  assertSupportedNodeVersion(options.nodeVersion);
  const git = new GitAdapter();
  const resolution = resolveRepository({ startPath: options.cwd, repoPath: options.repoPath, git });
  if (!resolution.repoRoot) {
    throw new RepositoryError("CCFlow requires a Git repository. Run `ccflow init --git` to create one here.");
  }

  const loadedConfig = loadConfig({ repoRoot: resolution.repoRoot, cliOverrides: options.cliConfig });
  const autoInit = options.autoInit ?? loadedConfig.config.startup.autoInit;
  if (!resolution.initialized && !autoInit) {
    throw new RepositoryError("This repository is not initialized for CCFlow. Run `ccflow init` or omit `--no-auto-init`.");
  }

  if (!isCcflowInitialized(resolution.repoRoot)) {
    initCcflowProject({ repoPath: resolution.repoRoot, git });
  }

  const state = loadInitializedState(resolution.repoRoot, git);
  applyConfigToState(state, loadedConfig.config);
  saveState(state);

  if (options.startTui) {
    await options.startTui(state, { config: loadedConfig.config });
    return;
  }
  await runBestAvailableTui(state, loadedConfig.config);
}

export function applyConfigToState(state: CcflowState, config: CcflowConfig): void {
  state.settings.worktree.enterLeafAutoSwitch = config.worktree.enterLeafAutoSwitch;
  state.settings.worktree.warnBeforeSwitch = config.worktree.warnBeforeSwitch;
  state.settings.merge.sealMergedInputs = config.merge.sealMergedInputs;
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
  const major = Number(version.split(".")[0]);
  if (!Number.isFinite(major) || major < 22) {
    throw new Error(`CCFlow requires Node.js >=22.0.0. Current version: ${version}`);
  }
}

export async function assertTuiRuntimeAvailable(): Promise<void> {
  try {
    await import("@opentui/core");
  } catch (error) {
    throw new Error(`Unable to load OpenTUI runtime dependency: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runBestAvailableTui(state: CcflowState, config: CcflowConfig): Promise<void> {
  try {
    const { runCcflowTui } = await import("./tui.js");
    await runCcflowTui(state, { config });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/bun-ffi-structs|OpenTUI|ffi|@opentui/i.test(message)) throw error;
    const { runBasicTui } = await import("./tui-basic.js");
    await runBasicTui(state, { config, reason: message });
  }
}
