import {
  Box,
  Text,
  TextAttributes,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { ClaudeAdapter } from "./core/claude.js";
import { defaultCcflowConfig } from "./core/config.js";
import { GitAdapter } from "./core/git.js";
import { getNode, getWorktree, isEditableLeaf, isLeafNode, isOperationBlockedNode, isSafeFocusTarget, switchCurrentWorktree } from "./core/graph.js";
import { JobRunner } from "./core/jobs.js";
import { logEvent } from "./core/log.js";
import { launchNodeSessionTab, reconcileNodeSessionState } from "./core/node-session.js";
import { saveSession, saveState } from "./core/storage.js";
import { terminalDisplayName } from "./core/terminal-tabs.js";
import { drainTerminalInputBuffer, releaseStdinForChildProcess, resetTerminalForChildProcess } from "./core/terminal.js";
import {
  buildEdgeLayer,
  chooseExistingFocusId,
  GRAPH_NODE_HEIGHT,
  ensureNodeVisible,
  layoutGraph,
  projectVisiblePositions,
  rankNodes,
  sanitizeGraphViewport,
  type GraphViewport,
} from "./core/tui-layout.js";
import { buildToasterOverlay, TOASTER_OVERLAY_ID } from "./tui/toast-overlay.js";
import {
  createToastExpiryScheduler,
  emitTuiErrorToast,
  emitTuiToast,
  formatUnknownError,
  isToastStillLoading,
  mergeToastDescription,
  toastStore,
} from "./tui/toast-actions.js";
import type { CcflowNode, CcflowState } from "./core/types.js";
import type { CcflowConfig } from "./core/config.js";

interface ActionToastResult {
  message: string;
  description?: string;
}

interface EnterLeafOptions {
  toastId?: string;
}

type Direction = "left" | "right" | "up" | "down";
type UiMode = "graph" | "detail";

const SIDE_PANEL_WIDTH = 30;

// Glass / minimal palette
const COLOR_OUTER_BG = "#08090c";
const COLOR_PANEL_BG = "#0d1117";
const COLOR_PRIMARY = "#e2e8f0";
const COLOR_SECONDARY = "#94a3b8";
const COLOR_TERTIARY = "#64748b";
const COLOR_QUATERNARY = "#475569";
const COLOR_DIM_RULE = "#1e293b";
const COLOR_FOCUS_ACCENT = "#7dd3fc";
const COLOR_FOCUS_INVERT_BG = "#e2e8f0";
const COLOR_FOCUS_INVERT_FG = "#020617";
const COLOR_STATUS_ERROR = "#fca5a5";
const COLOR_STATUS_RUNNING = "#7dd3fc";
const COLOR_STATUS_AWAITING = "#fcd34d";
const COLOR_STATUS_SEALED = "#64748b";
const COLOR_CURRENT_LEAF = "#86efac";
const COLOR_OTHER_LEAF = "#fde68a";
const COLOR_SELECTED_BAR = "#fde68a";

const ERROR_STATUSES = new Set([
  "CommitFailed",
  "MergeConflict",
  "JobFailed",
  "ParentCommitFailed",
]);

const RUNNING_STATUSES = new Set([
  "LeafRunning",
  "Committing",
  "ParentCommitting",
  "MergeRunning",
  "Deleting",
  "AwaitingParentCommit",
]);

interface InputMode {
  prompt: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

interface UiState {
  focusId: string;
  selectedIds: Set<string>;
  mode: UiMode;
  message: string;
  task: string | null;
  busy: boolean;
  graphViewport: GraphViewport;
  inputMode: InputMode | null;
  inputValue: string;
}

interface TuiExit {
  kind: "quit" | "enter";
  nodeId?: string;
}

interface NodeAccent {
  bar: string;
  bg: string;
  fg: string;
  dim: string;
}

export async function runCcflowTui(state: CcflowState, options: { config?: CcflowConfig } = {}): Promise<void> {
  const git = new GitAdapter();
  const claude = new ClaudeAdapter();
  const jobs = new JobRunner(git, claude);
  const ui = createInitialUiState(state);
  let loop = 0;
  logEvent(state.repoRoot, "tui:run:start", {
    focusId: ui.focusId,
    currentNodeId: state.currentNodeId,
    currentWorktreeId: state.currentWorktreeId,
  });

  while (true) {
    loop += 1;
    logEvent(state.repoRoot, "tui:loop:start", {
      loop,
      focusId: ui.focusId,
      currentNodeId: state.currentNodeId,
      currentWorktreeId: state.currentWorktreeId,
    });
    refreshDirtyStatuses(state, git);
    const exit = await runGraphOnce(state, ui, jobs, claude, options.config);
    logEvent(state.repoRoot, "tui:graph:exit", {
      loop,
      kind: exit.kind,
      nodeId: exit.nodeId ?? null,
      focusId: ui.focusId,
    });
    if (exit.kind === "quit") return;
    if (exit.kind === "enter" && exit.nodeId) {
      await enterLeaf(state, exit.nodeId, claude, ui, options.config);
      logEvent(state.repoRoot, "tui:enter:return-to-loop", {
        loop,
        nodeId: exit.nodeId,
        focusId: ui.focusId,
        message: ui.message,
      });
    }
  }
}

function createInitialUiState(state: CcflowState): UiState {
  return {
    focusId: chooseExistingFocusId(state, state.ui?.focusNodeId),
    selectedIds: new Set(),
    mode: "graph",
    message: "",
    task: null,
    busy: false,
    graphViewport: sanitizeGraphViewport(state.ui?.graphViewport),
    inputMode: null,
    inputValue: "",
  };
}

function persistUiPreferences(state: CcflowState, ui: UiState): void {
  state.ui = {
    focusNodeId: chooseExistingFocusId(state, ui.focusId),
    graphViewport: sanitizeGraphViewport(ui.graphViewport),
  };
}

async function runGraphOnce(
  state: CcflowState,
  ui: UiState,
  jobs: JobRunner,
  claude: ClaudeAdapter,
  config?: CcflowConfig,
): Promise<TuiExit> {
  const previousOpenTuiGraphics = process.env.OPENTUI_GRAPHICS;
  process.env.OPENTUI_GRAPHICS = "false";
  let renderer: CliRenderer;
  try {
    logEvent(state.repoRoot, "tui:renderer:create-start", {
      focusId: ui.focusId,
      currentNodeId: state.currentNodeId,
    });
    renderer = await createCliRenderer({
      exitOnCtrlC: false,
      clearOnShutdown: true,
      screenMode: "alternate-screen",
      targetFps: 30,
      consoleMode: "disabled",
      // OpenTUI currently treats null/undefined as default Kitty flags; false keeps normal bytes for Claude.
      useKittyKeyboard: false as never,
      useMouse: false,
      enableMouseMovement: false,
      backgroundColor: COLOR_OUTER_BG,
    });
    logEvent(state.repoRoot, "tui:renderer:create-done", {
      width: renderer.terminalWidth || renderer.width || null,
      height: renderer.terminalHeight || renderer.height || null,
    });
  } finally {
    restoreEnvValue("OPENTUI_GRAPHICS", previousOpenTuiGraphics);
  }
  renderer.disableKittyKeyboard();

  let settled = false;
  let sessionPoll: NodeJS.Timeout | null = null;
  let stopToastExpiryScheduler: (() => void) | null = null;
  const settle = (result: TuiExit) => {
    if (settled) return;
    settled = true;
    if (sessionPoll) clearInterval(sessionPoll);
    sessionPoll = null;
    stopToastExpiryScheduler?.();
    stopToastExpiryScheduler = null;
    logEvent(state.repoRoot, "tui:graph:settle-start", {
      kind: result.kind,
      nodeId: result.nodeId ?? null,
      focusId: ui.focusId,
    });
    void (async () => {
      renderer.disableKittyKeyboard();
      renderer.suspend();
      const destroyed = new Promise<void>((resolve) => renderer.once("destroy", () => resolve()));
      renderer.destroy();
      await destroyed;
      resetTerminalForChildProcess();
      releaseStdinForChildProcess();
      drainTerminalInputBuffer();
      resetTerminalForChildProcess();
      logEvent(state.repoRoot, "tui:graph:settle-done", {
        kind: result.kind,
        nodeId: result.nodeId ?? null,
        focusId: ui.focusId,
      });
      resolve(result);
    })();
  };

  let resolve!: (value: TuiExit) => void;
  const done = new Promise<TuiExit>((innerResolve) => {
    resolve = innerResolve;
  });

  const rerender = () => renderApp(renderer, state, ui, config);
  const toastExpiryScheduler = createToastExpiryScheduler(toastStore, () => {
    if (!settled) rerender();
  });
  stopToastExpiryScheduler = () => toastExpiryScheduler.dispose();
  const persistAndSaveState = () => {
    persistUiPreferences(state, ui);
    saveState(state);
  };
  const reconcileAndSaveState = () => {
    if (!reconcileNodeSessionState(state)) return false;
    persistAndSaveState();
    return true;
  };
  const runAction = async (
    label: string,
    action: (toastId: string) => Promise<ActionToastResult | void> | ActionToastResult | void,
  ) => {
    if (ui.busy) return;
    ui.busy = true;
    ui.task = label;
    ui.message = label;
    const toastId = emitTuiToast("loading", label);
    rerender();
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const result = await action(toastId);
      if (result) {
        emitTuiToast("success", result.message, { id: toastId, description: result.description });
      } else if (isToastStillLoading(toastId)) {
        toastStore.dismiss(toastId);
      }
      persistAndSaveState();
    } catch (error) {
      ui.message = formatUnknownError(error);
      emitTuiErrorToast("Action failed", error, toastId);
    } finally {
      ui.busy = false;
      ui.task = null;
      rerender();
    }
  };

  sessionPoll = setInterval(() => {
    if (settled) return;
    if (reconcileAndSaveState()) rerender();
  }, 2000);
  sessionPoll.unref?.();

  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") {
      persistAndSaveState();
      logEvent(state.repoRoot, "tui:key:ctrl-c", {
        focusId: ui.focusId,
        mode: ui.mode,
        busy: ui.busy,
      });
      settle({ kind: "quit" });
      key.preventDefault();
      return;
    }

    if (ui.inputMode) {
      if (key.name === "enter" || key.name === "return" || key.sequence === "\r") {
        const cb = ui.inputMode.onConfirm;
        const val = ui.inputValue;
        ui.inputMode = null;
        ui.inputValue = "";
        cb(val);
        key.preventDefault();
        return;
      }
      if (key.name === "escape") {
        const cb = ui.inputMode.onCancel;
        ui.inputMode = null;
        ui.inputValue = "";
        cb();
        key.preventDefault();
        return;
      }
      if (key.name === "backspace") {
        ui.inputValue = ui.inputValue.slice(0, -1);
        rerender();
        key.preventDefault();
        return;
      }
      if (key.sequence && key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32 && !key.ctrl && !key.meta) {
        ui.inputValue += key.sequence;
        rerender();
        key.preventDefault();
        return;
      }
      key.preventDefault();
      return;
    }

    const direction = keyToDirection(key);
    if (direction && ui.mode === "graph") {
      ui.focusId = moveFocus(state, ensureUiFocus(state, ui).id, direction);
      rerender();
      key.preventDefault();
      return;
    }
    if (ui.busy) return;

    if (key.name === "return" || key.name === "enter") {
      reconcileAndSaveState();
      const node = ensureUiFocus(state, ui);
      if (!isLeafNode(state, node.id)) {
        ui.mode = "detail";
        rerender();
        return;
      }
      if (!isEditableLeaf(state, node.id) && node.status !== "MergeConflict") {
        const reason = node.blockedReason || node.error || `Node is not editable: ${node.status}`;
        ui.message = reason;
        emitTuiToast("error", "Node blocked", { description: reason });
        rerender();
        return;
      }
      if (isMultitabEnabled(config)) {
        void runAction("opening node tab...", async (toastId) => {
          await enterLeaf(state, node.id, claude, ui, config, { toastId });
        });
        return;
      }
      persistAndSaveState();
      settle({ kind: "enter", nodeId: node.id });
      return;
    }

    if (key.name === "escape") {
      if (ui.mode === "detail") ui.mode = "graph";
      else ui.selectedIds.clear();
      rerender();
      return;
    }

    if (key.sequence === "q") {
      persistAndSaveState();
      settle({ kind: "quit" });
      return;
    }

    if (isShiftTab(key)) {
      const plan = jobs.branchCreationPlan(state, ensureUiFocus(state, ui).id);
      const choices = plan.branches.map((branch, index) => `${index + 1}:${branch}`).join("  ");
      ui.inputMode = {
        prompt: plan.requiresName
          ? "New branch name: "
          : `Branch (${choices}  new:<name>): `,
        onConfirm: (value: string) => {
          void runAction("creating sibling...", async () => {
            const sibling = await jobs.createSiblingNode(state, ensureUiFocus(state, ui).id, parseBranchTarget(value, plan));
            ui.focusId = sibling.id;
            ui.selectedIds.clear();
            ui.mode = "graph";
            ui.message = `Created sibling ${sibling.id}`;
            return { message: `Created sibling ${sibling.id}` };
          });
        },
        onCancel: () => {
          void runAction("creating sibling...", async () => {
            const sibling = await jobs.createSiblingNode(state, ensureUiFocus(state, ui).id, plan.defaultBranch ? { kind: "existing", branch: plan.defaultBranch } : undefined);
            ui.focusId = sibling.id;
            ui.selectedIds.clear();
            ui.mode = "graph";
            ui.message = `Created sibling ${sibling.id}`;
            return { message: `Created sibling ${sibling.id}` };
          });
        },
      };
      ui.inputValue = "";
      rerender();
      key.preventDefault();
      return;
    }

    if (isTab(key)) {
      void runAction("creating next node...", async () => {
        const child = await jobs.createNextNode(state, ensureUiFocus(state, ui).id);
        ui.focusId = child.id;
        ui.selectedIds.clear();
        ui.mode = "graph";
        ui.message = child.status === "AwaitingParentCommit" ? `Created ${child.id}; parent commit running` : `Created ${child.id}`;
        return {
          message: `Created ${child.id}`,
          description: child.status === "AwaitingParentCommit" ? "parent commit running" : undefined,
        };
      });
      key.preventDefault();
      return;
    }

    if (key.sequence === "d") {
      void runAction("deleting leaf... resetting worktree...", async () => {
        const focus = await jobs.deleteLeaf(state, ensureUiFocus(state, ui).id);
        ui.focusId = focus.id;
        ui.selectedIds.delete(ui.focusId);
        ui.selectedIds.clear();
        ui.mode = "graph";
        ui.message = `Deleted leaf; reset to ${focus.id}`;
        return { message: "Deleted leaf", description: `reset to ${focus.id}` };
      });
      return;
    }

    if (key.name === "space" || key.sequence === " ") {
      const node = ensureUiFocus(state, ui);
      if (isLeafNode(state, node.id)) {
        if (ui.selectedIds.has(node.id)) ui.selectedIds.delete(node.id);
        else ui.selectedIds.add(node.id);
      }
      rerender();
      return;
    }

    if (key.sequence === "s") {
      void runAction("Switching worktree", () => {
        const node = ensureUiFocus(state, ui);
        if (isOperationBlockedNode(state, node.id)) {
          throw new Error(node.blockedReason || node.error || `Node is blocked: ${node.status}`);
        }
        const worktree = switchCurrentWorktree(state, node.id);
        ui.message = `Current worktree: ${worktree.path}`;
        return { message: "Switched worktree", description: worktree.path };
      });
      return;
    }

    if (key.sequence === "m") {
      if (ui.busy) return;
      ui.busy = true;
      ui.task = "merging...";
      ui.message = "merging...";
      const toastId = emitTuiToast("loading", "merging...");
      rerender();
      (async () => {
        try {
          await new Promise<void>((r) => setTimeout(r, 0));
          const merge = await jobs.mergeLeaves(state, [...ui.selectedIds]);
          saveState(state);
          ui.focusId = merge.id;
          ui.selectedIds.clear();
          if (merge.status === "MergeConflict") {
            emitTuiToast("warning", "Merge conflict", { id: toastId, description: mergeToastDescription(merge) });
            if (isMultitabEnabled(config)) {
              await enterLeaf(state, merge.id, claude, ui, config);
            } else {
              ui.busy = false;
              ui.task = null;
              settle({ kind: "enter", nodeId: merge.id });
            }
            return;
          }
          ui.message = `Merge node ${merge.id}`;
          emitTuiToast("success", `Merge node ${merge.id}`, { id: toastId });
        } catch (error) {
          ui.message = formatUnknownError(error);
          emitTuiErrorToast("Merge failed", error, toastId);
        } finally {
          if (!settled) {
            ui.busy = false;
            ui.task = null;
            rerender();
          }
        }
      })();
    }
  });

  renderer.on("resize", rerender);
  renderer.on("destroy", () => {
    if (!settled) {
      if (sessionPoll) clearInterval(sessionPoll);
      sessionPoll = null;
      stopToastExpiryScheduler?.();
      stopToastExpiryScheduler = null;
      logEvent(state.repoRoot, "tui:renderer:destroy-unexpected", {
        focusId: ui.focusId,
        currentNodeId: state.currentNodeId,
      });
      try {
        persistAndSaveState();
      } catch {
        // The destroy path must still resolve even if the graph was already torn down.
      }
      settled = true;
      resolve({ kind: "quit" });
    }
  });

  rerender();
  logEvent(state.repoRoot, "tui:renderer:start", {
    focusId: ui.focusId,
    currentNodeId: state.currentNodeId,
  });
  renderer.start();
  return done;
}

async function enterLeaf(
  state: CcflowState,
  nodeId: string,
  claude: ClaudeAdapter,
  ui: UiState,
  config?: CcflowConfig,
  options: EnterLeafOptions = {},
): Promise<void> {
  if (isMultitabEnabled(config)) {
    await enterLeafInTerminalTab(state, nodeId, ui, config, options);
    return;
  }
  await enterLeafInCurrentTab(state, nodeId, claude, ui, config, options);
}

async function enterLeafInTerminalTab(
  state: CcflowState,
  nodeId: string,
  ui: UiState,
  config?: CcflowConfig,
  options: EnterLeafOptions = {},
): Promise<void> {
  const node = getNode(state, nodeId);
  const worktree = getWorktree(state, node.git.worktreeId);
  logEvent(state.repoRoot, "tui:enter:start", {
    nodeId: node.id,
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    resumeMode: node.cc.resumeMode,
    sessionId: node.cc.sessionId,
  });

  try {
    const result = await launchNodeSessionTab(state, node.id, config ?? defaultCcflowConfig());
    const terminalName = result.terminalName ?? terminalDisplayName(result.terminal);
    const target = result.target ?? "tab";
    logEvent(state.repoRoot, "tui:enter:attached", {
      nodeId: node.id,
      terminal: result.terminal,
      target,
    });
    ui.focusId = node.id;
    ui.message = `Opened ${node.id} in ${terminalName} ${target}`;
    emitTuiToast("success", `Opened ${node.id}`, { id: options.toastId, description: `${terminalName} ${target}` });
    logEvent(state.repoRoot, "tui:enter:done", {
      nodeId: node.id,
      status: node.status,
      focusId: ui.focusId,
      sessionId: node.cc.sessionId,
      terminal: result.terminal,
      target,
    });
  } catch (error) {
    ui.message = formatUnknownError(error);
    emitTuiErrorToast("Cannot open Claude", error, options.toastId);
    logEvent(state.repoRoot, "tui:enter:error", {
      nodeId: node.id,
      error: ui.message,
      focusId: ui.focusId,
    });
  }
}

async function enterLeafInCurrentTab(
  state: CcflowState,
  nodeId: string,
  claude: ClaudeAdapter,
  ui: UiState,
  config?: CcflowConfig,
  options: EnterLeafOptions = {},
): Promise<void> {
  const node = getNode(state, nodeId);
  const worktree = getWorktree(state, node.git.worktreeId);
  if (state.settings.worktree.enterLeafAutoSwitch) {
    switchCurrentWorktree(state, node.id);
  }

  node.status = "LeafRunning";
  node.cc.processId = null;
  node.cc.resumeMode = node.cc.sessionId ? "resume" : "new";
  node.error = null;
  node.updatedAt = new Date().toISOString();
  saveState(state);
  logEvent(state.repoRoot, "tui:enter:start", {
    nodeId: node.id,
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    resumeMode: node.cc.resumeMode,
    sessionId: node.cc.sessionId,
    target: "current-tab",
  });

  try {
    const result = await claude.attachOrResume(node, worktree.path, state.repoRoot, config);
    logEvent(state.repoRoot, "tui:enter:attached", {
      nodeId: node.id,
      resultSessionId: result.sessionId,
      alive: result.alive,
      target: "current-tab",
    });
    node.cc.sessionId = result.sessionId;
    node.cc.processId = null;
    node.cc.resumeMode = result.sessionId ? "resume" : "new";
    node.status = result.sessionId ? "LeafResumable" : "LeafNew";
    node.updatedAt = new Date().toISOString();
    saveSession(state.repoRoot, node);
    saveState(state);
    ui.focusId = node.id;
    ui.message = "Claude session ended";
    emitTuiToast("success", "Claude session ended", { id: options.toastId });
    logEvent(state.repoRoot, "tui:enter:done", {
      nodeId: node.id,
      status: node.status,
      focusId: ui.focusId,
      sessionId: node.cc.sessionId,
      target: "current-tab",
    });
  } catch (error) {
    node.status = "JobFailed";
    node.cc.processId = null;
    node.error = error instanceof Error ? error.message : String(error);
    saveState(state);
    ui.message = node.error ?? "Failed to enter Claude";
    emitTuiToast("error", "Cannot open Claude", { id: options.toastId, description: ui.message });
    logEvent(state.repoRoot, "tui:enter:error", {
      nodeId: node.id,
      error: node.error,
      target: "current-tab",
    });
  }
}

function refreshDirtyStatuses(state: CcflowState, git: GitAdapter): void {
  for (const node of Object.values(state.nodes)) {
    if (!isLeafNode(state, node.id)) continue;
    if (
      node.locked ||
      node.status === "LeafRunning" ||
      node.status === "LeafSuspended" ||
      node.status === "AwaitingParentCommit" ||
      node.status === "ParentCommitFailed"
    ) continue;
    const worktree = state.worktrees[node.git.worktreeId];
    if (!worktree) continue;
    try {
      node.status = git.hasDirtyChanges(worktree.path) ? "LeafDirty" : node.cc.sessionId ? "LeafResumable" : "LeafNew";
    } catch {
      // The UI should keep loading even if a worktree was removed externally.
    }
  }
}

function renderApp(renderer: CliRenderer, state: CcflowState, ui: UiState, config?: CcflowConfig): void {
  try {
    renderer.root.remove("app");
  } catch {
    // First render has no app tree yet.
  }
  try {
    renderer.root.remove(TOASTER_OVERLAY_ID);
  } catch {
    // First render has no toaster overlay yet.
  }

  const width = Math.max(76, renderer.terminalWidth || renderer.width || 120);
  const height = Math.max(26, renderer.terminalHeight || renderer.height || 36);
  const compact = width < 116;
  const graphWidth = compact ? Math.max(70, width - 2) : Math.max(70, width - SIDE_PANEL_WIDTH - 4);
  const panelHeight = Math.max(19, height - 3);
  const focusNode = ensureUiFocus(state, ui);

  renderer.root.add(
    Box(
      {
        id: "app",
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: COLOR_OUTER_BG,
      },
      Box(
        {
          flexGrow: 1,
          flexDirection: "row",
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 1,
          gap: 0,
          backgroundColor: COLOR_OUTER_BG,
        },
        ui.mode === "detail" ? detailPanel(state, focusNode, graphWidth, panelHeight, config) : graphPanel(state, ui, focusNode, graphWidth, panelHeight),
        compact ? compactSummary(state, focusNode, ui) : sidePanel(state, focusNode, ui, panelHeight),
      ),
      footer(ui, config),
    ),
  );
  renderer.root.add(buildToasterOverlay(toastStore));

  renderer.requestRender();
}

function ensureUiFocus(state: CcflowState, ui: UiState): CcflowNode {
  for (const selectedId of [...ui.selectedIds]) {
    if (!state.nodes[selectedId]) ui.selectedIds.delete(selectedId);
  }

  const existing = state.nodes[ui.focusId];
  if (existing) return existing;

  const fallback =
    state.nodes[state.currentNodeId] ??
    Object.values(state.nodes).find((node) => isSafeFocusTarget(state, node.id)) ??
    Object.values(state.nodes)[0];
  if (!fallback) throw new Error("No nodes available to focus");

  ui.focusId = fallback.id;
  ui.mode = "graph";
  if (!ui.message) {
    ui.message = `Focus moved to ${fallback.id}`;
    emitTuiToast("info", ui.message);
  }
  return fallback;
}

function restoreEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function graphPanel(state: CcflowState, ui: UiState, focusNode: CcflowNode, width: number, height: number) {
  const canvasWidth = width - 2;
  const canvasHeight = height - 2;
  const positions = layoutGraph(state);
  ui.graphViewport = ensureNodeVisible(ui.graphViewport, positions, focusNode.id, canvasWidth, canvasHeight);
  const edgeLayer = buildEdgeLayer(state, positions, canvasWidth, canvasHeight, ui.graphViewport);
  const visiblePositions = projectVisiblePositions(positions, ui.graphViewport, canvasWidth, canvasHeight);
  const basename = basenameOfRepoPath(state.repoRoot);
  const titleWidth = Math.max(10, width - 2);
  const titleLeft = `▄ CCFLOW · `;
  const titleMid = basename;
  const titleRight = "  ";
  const consumed = titleLeft.length + titleMid.length + titleRight.length;
  const filler = "─".repeat(Math.max(0, titleWidth - consumed));
  const titleLeftX = 1;
  const titleMidX = titleLeftX + titleLeft.length;
  const titleRightX = titleMidX + titleMid.length;
  const fillerX = titleRightX + titleRight.length;

  return Box(
    {
      width,
      height,
      backgroundColor: COLOR_OUTER_BG,
      position: "relative",
      overflow: "hidden",
    },
    Text({
      content: edgeLayer,
      fg: "#1e293b",
      position: "absolute",
      left: 1,
      top: 1,
      width: canvasWidth,
      height: canvasHeight,
    }),
    Text({
      content: titleLeft,
      fg: COLOR_FOCUS_ACCENT,
      position: "absolute",
      top: 0,
      left: titleLeftX,
    }),
    Text({
      content: titleMid,
      fg: COLOR_SECONDARY,
      position: "absolute",
      top: 0,
      left: titleMidX,
    }),
    Text({
      content: titleRight,
      fg: COLOR_SECONDARY,
      position: "absolute",
      top: 0,
      left: titleRightX,
    }),
    Text({
      content: filler,
      fg: COLOR_DIM_RULE,
      position: "absolute",
      top: 0,
      left: fillerX,
    }),
    ...visiblePositions.map((pos) =>
      nodeCard(state, pos.node, pos.x + 1, pos.y + 1, pos.width, ui.focusId === pos.node.id, ui.selectedIds.has(pos.node.id)),
    ),
  );
}

function basenameOfRepoPath(repoRoot: string): string {
  const parts = repoRoot.split(/[\\/]/);
  return parts[parts.length - 1] || repoRoot;
}

function nodeCard(
  state: CcflowState,
  node: CcflowNode,
  left: number,
  top: number,
  width: number,
  focused: boolean,
  selected: boolean,
) {
  const accent = nodeAccent(state, node);
  const worktree = getWorktree(state, node.git.worktreeId);
  const indicator = nodeIndicator(state, node);
  const commit = node.git.commitHash ? node.git.commitHash.slice(0, 7) : "uncommitted";

  const errored = ERROR_STATUSES.has(node.status);
  const cardBg = focused ? COLOR_FOCUS_INVERT_BG : accent.bg;
  const cardFg = focused ? COLOR_FOCUS_INVERT_FG : accent.fg;
  const dimFg = focused ? "#0f172a" : accent.dim;
  const barColor = focused
    ? COLOR_FOCUS_INVERT_FG
    : errored
      ? COLOR_STATUS_ERROR
      : selected
        ? COLOR_SELECTED_BAR
        : accent.bar;
  const titleBold = focused || selected;
  const innerWidth = Math.max(0, width - 2);

  return Box(
    {
      position: "absolute",
      left,
      top,
      width,
      height: GRAPH_NODE_HEIGHT,
      backgroundColor: cardBg,
      paddingLeft: 1,
      paddingRight: 1,
      flexDirection: "column",
    },
    Text({
      content: "▌",
      fg: barColor,
      position: "absolute",
      left: -1,
      top: 0,
      width: 1,
      height: GRAPH_NODE_HEIGHT,
    }),
    Text({
      content: `${indicator} ${truncate(node.title, Math.max(0, innerWidth - 2))}`,
      fg: cardFg,
      attributes: titleBold ? TextAttributes.BOLD : TextAttributes.NONE,
    }),
    Text({
      content: truncate(`${node.type} · ${node.status}`, innerWidth),
      fg: focused ? "#0f172a" : accent.bar,
    }),
    Text({
      content: truncate(`commit ${commit}  wt ${worktree.branch}`, innerWidth),
      fg: dimFg,
    }),
  );
}

function sidePanel(state: CcflowState, node: CcflowNode, ui: UiState, height: number) {
  const worktree = getWorktree(state, node.git.worktreeId);
  const accent = nodeAccent(state, node);
  const commitMessageBody = node.git.commitHash ? messageBody(node.git.commitMessage?.trim() || node.title) : "";
  // `VChild` is defined in `@opentui/core` internals but not re-exported; we
  // only ever push `Box`/`Text` results into these arrays, so `any[]` is safe.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const children: any[] = [
    Text({ content: "▌", fg: accent.bar, position: "absolute", left: -1, top: 0, width: 1, height }),
    Text({ content: node.title, fg: accent.bar, attributes: TextAttributes.BOLD }),
    fieldStack("status", node.status, statusColor(node.status)),
    fieldStack("branch", worktree.branch, accent.fg),
    fieldStack(
      "worktree",
      worktree.locked ? `${worktree.status} locked` : worktree.status,
      worktree.locked ? COLOR_FOCUS_ACCENT : worktree.status === "current" ? COLOR_CURRENT_LEAF : COLOR_OTHER_LEAF,
    ),
  ];
  if (node.jobId) children.push(fieldStack("job", node.jobId, COLOR_FOCUS_ACCENT));
  if (node.pendingParentJobId) children.push(fieldStack("parent job", node.pendingParentJobId, COLOR_FOCUS_ACCENT));
  if (node.conflictFiles?.length) children.push(fieldStack("conflicts", node.conflictFiles.join(", "), COLOR_STATUS_ERROR));
  if (node.blockedReason) children.push(fieldStack("blocked", node.blockedReason, COLOR_STATUS_AWAITING));
  if (node.error) children.push(fieldStack("error", node.error, COLOR_STATUS_ERROR));

  children.push(statsBlock(node));
  if (commitMessageBody) children.push(commitMessageBlock(commitMessageBody));
  children.push(messageLine(ui));

  return Box(
    {
      width: SIDE_PANEL_WIDTH,
      height,
      backgroundColor: COLOR_PANEL_BG,
      paddingLeft: 2,
      paddingRight: 1,
      paddingTop: 1,
      flexDirection: "column",
      gap: 1,
      position: "relative",
    },
    ...children,
  );
}

function commitMessageBlock(body: string) {
  // sidePanel 宽 30, paddingLeft 2 + paddingRight 1, "│ " 前缀 2 字符 → body 可用 25 字符
  const innerWidth = Math.max(1, SIDE_PANEL_WIDTH - 2 - 1 - 2);
  return Box(
    { flexDirection: "column" },
    ...wrapText(body, innerWidth).map((line) =>
      Box(
        { flexDirection: "row" },
        Text({ content: "│ ", fg: COLOR_QUATERNARY }),
        Text({ content: line, fg: COLOR_SECONDARY }),
      ),
    ),
  );
}

function statsBlock(node: CcflowNode) {
  return Box(
    { flexDirection: "column" },
    Text({ content: "S T A T S", fg: COLOR_TERTIARY }),
    Text({
      content: `${node.stats.filesChanged} files  +${node.stats.insertions}  -${node.stats.deletions}`,
      fg: "#cbd5e1",
    }),
  );
}

function messageLine(ui: UiState) {
  const prefix = Text({ content: "▸ ", fg: COLOR_FOCUS_ACCENT });
  const text = Text({
    content: ui.message || "Ready",
    fg: ui.busy ? COLOR_STATUS_AWAITING : COLOR_TERTIARY,
    wrapMode: "word",
  });
  return Box({ flexDirection: "row" }, prefix, text);
}

function messageBody(message: string): string {
  return message
    .split(/\r?\n/)
    .slice(1)
    .join("\n")
    .trim();
}

function compactSummary(state: CcflowState, node: CcflowNode, ui: UiState) {
  const worktree = getWorktree(state, node.git.worktreeId);
  const accent = nodeAccent(state, node);
  return Box(
    {
      position: "absolute",
      left: 2,
      bottom: 2,
      width: widthPercent(95),
      height: 4,
      backgroundColor: COLOR_PANEL_BG,
      paddingLeft: 1,
      paddingRight: 1,
      flexDirection: "column",
    },
    Text({ content: "▌", fg: accent.bar, position: "absolute", left: -1, top: 0, width: 1, height: 4 }),
    Text({ content: `${node.title}  ${worktree.branch}`, fg: accent.bar, attributes: TextAttributes.BOLD }),
    Text({ content: ui.message || `${node.type} ${node.status}`, fg: COLOR_SECONDARY }),
  );
}

function widthPercent(value: number): `${number}%` {
  return `${value}%` as `${number}%`;
}

function detailPanel(state: CcflowState, node: CcflowNode, width: number, height: number, config?: CcflowConfig) {
  const worktree = getWorktree(state, node.git.worktreeId);
  const launchMode = isMultitabEnabled(config) ? "new tab" : "current tab";
  const accent = nodeAccent(state, node);
  const divider = "─".repeat(Math.max(0, width - 2));
  const lines: Array<{ label: string; value: string; color: string }> = [
    { label: "TITLE", value: node.title, color: accent.bar },
    { label: "STATUS", value: node.status, color: statusColor(node.status) },
    { label: "TYPE", value: node.type, color: "#cbd5e1" },
    { label: "ID", value: node.id, color: COLOR_TERTIARY },
    { label: "COMMIT", value: node.git.commitHash ?? "none", color: COLOR_TERTIARY },
    { label: "BRANCH", value: node.git.branch, color: COLOR_TERTIARY },
    { label: "WORKTREE", value: worktree.path, color: "#cbd5e1" },
    { label: "PARENTS", value: node.parents.join(", ") || "none", color: "#cbd5e1" },
    { label: "CHILDREN", value: node.children.join(", ") || "none", color: "#cbd5e1" },
    { label: "CC SESSION", value: node.cc.sessionId ?? "none", color: "#cbd5e1" },
    { label: "JOB", value: node.jobId ?? "none", color: "#cbd5e1" },
    { label: "PARENT JOB", value: node.pendingParentJobId ?? "none", color: "#cbd5e1" },
    { label: "BLOCKED", value: node.blockedReason ?? "none", color: "#cbd5e1" },
    { label: "CONFLICTS", value: node.conflictFiles?.join(", ") || "none", color: "#cbd5e1" },
    { label: "CC LAUNCH", value: launchMode, color: "#cbd5e1" },
    { label: "FILES CHANGED", value: String(node.stats.filesChanged), color: "#cbd5e1" },
    { label: "INSERTIONS", value: String(node.stats.insertions), color: "#cbd5e1" },
    { label: "DELETIONS", value: String(node.stats.deletions), color: "#cbd5e1" },
    { label: "SYMBOLS", value: node.stats.symbolsChanged.join(", ") || "none", color: "#cbd5e1" },
  ];
  if (node.error) lines.push({ label: "ERROR", value: node.error, color: COLOR_STATUS_ERROR });

  const labelWidth = Math.max(...lines.map((line) => line.label.length)) + 2;
  const maxValueWidth = Math.max(0, width - 4 - labelWidth);

  return Box(
    {
      width,
      height,
      backgroundColor: COLOR_PANEL_BG,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      flexDirection: "column",
      gap: 0,
    },
    Text({ content: divider, fg: COLOR_DIM_RULE }),
    ...lines.map((line) =>
      Box(
        { flexDirection: "row" },
        Text({ content: line.label.padEnd(labelWidth), fg: COLOR_TERTIARY }),
        Text({ content: truncate(line.value, maxValueWidth), fg: line.color, attributes: line.label === "TITLE" ? TextAttributes.BOLD : TextAttributes.NONE }),
      ),
    ),
  );
}

function footer(ui: UiState, config?: CcflowConfig) {
  if (ui.inputMode) {
    return Box(
      {
        height: 1,
        alignItems: "center",
        paddingLeft: 2,
        backgroundColor: COLOR_OUTER_BG,
      },
      Text({ content: ui.inputMode.prompt, fg: COLOR_FOCUS_ACCENT }),
      Text({ content: ui.inputValue, fg: COLOR_PRIMARY }),
      Text({ content: "▌", fg: COLOR_FOCUS_ACCENT }),
    );
  }

  if (ui.mode === "detail") {
    return Box(
      {
        height: 1,
        alignItems: "center",
        paddingLeft: 2,
        backgroundColor: COLOR_OUTER_BG,
      },
      Text({ content: "▸ esc graph   ▸ q quit", fg: COLOR_TERTIARY }),
    );
  }

  const sections: Array<{ key: string; label: string }> = [
    { key: "arrows", label: "arrows move" },
    { key: "enter", label: "⏎ enter" },
    { key: "tab", label: "⇥ next" },
    { key: "shift-tab", label: "⇧⇥ sibling" },
    { key: "space", label: "space select" },
    { key: "m", label: "m merge" },
    { key: "s", label: "s switch" },
    { key: "d", label: "d delete" },
    { key: "q", label: "q quit" },
  ];
  // Highlight the contextual "current" mode hint: enter is the primary action
  // the user is most likely to take when a node is focused.
  const currentKey = "enter";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fragments: any[] = [];
  sections.forEach((section, index) => {
    if (index > 0) {
      fragments.push(Text({ content: "  ▸  ", fg: COLOR_TERTIARY }));
    }
    fragments.push(
      Text({
        content: section.label,
        fg: section.key === currentKey ? COLOR_FOCUS_ACCENT : COLOR_TERTIARY,
      }),
    );
  });

  return Box(
    {
      height: 1,
      alignItems: "center",
      paddingLeft: 2,
      backgroundColor: COLOR_OUTER_BG,
    },
    ...fragments,
  );
}

function isMultitabEnabled(config?: CcflowConfig): boolean {
  return config?.terminal.multitab ?? false;
}

function fieldStack(label: string, value: string, color: string) {
  const rule = "─".repeat(Math.max(0, Math.min(18, value.length)));
  return Box(
    { flexDirection: "column" },
    Text({ content: label.toUpperCase(), fg: COLOR_TERTIARY }),
    Text({ content: rule, fg: COLOR_DIM_RULE }),
    Text({ content: value, fg: color, wrapMode: "word" }),
  );
}

function parseBranchTarget(value: string, plan: ReturnType<JobRunner["branchCreationPlan"]>) {
  const trimmed = value.trim();
  if (plan.requiresName) return { kind: "new" as const, name: trimmed };
  if (!trimmed && plan.defaultBranch) return { kind: "existing" as const, branch: plan.defaultBranch };
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= plan.branches.length) {
    return { kind: "existing" as const, branch: plan.branches[numeric - 1]! };
  }
  if (trimmed.startsWith("new:")) {
    return { kind: "new" as const, name: trimmed.slice("new:".length).trim() };
  }
  if (plan.branches.includes(trimmed)) return { kind: "existing" as const, branch: trimmed };
  return { kind: "new" as const, name: trimmed };
}

function keyToDirection(key: KeyEvent): Direction | null {
  if (key.name === "left" || key.sequence === "h") return "left";
  if (key.name === "right" || key.sequence === "l") return "right";
  if (key.name === "up" || key.sequence === "k") return "up";
  if (key.name === "down" || key.sequence === "j") return "down";
  return null;
}

function isTab(key: KeyEvent): boolean {
  return key.name === "tab" && !key.shift && (key.sequence === "\t" || key.raw === "\t");
}

function isShiftTab(key: KeyEvent): boolean {
  return key.name === "tab" && (key.shift || key.sequence === "\u001b[Z" || key.raw === "\u001b[Z");
}

function moveFocus(state: CcflowState, currentId: string, direction: Direction): string {
  const ranked = rankNodes(state);
  const current = ranked.get(currentId);
  if (!current) return currentId;
  const candidates = [...ranked.entries()]
    .filter(([id]) => id !== currentId)
    .map(([id, position]) => ({
      id,
      dx: position.lane - current.lane,
      dy: position.row - current.row,
    }))
    .filter(({ dx, dy }) => {
      if (direction === "left") return dx < 0;
      if (direction === "right") return dx > 0;
      if (direction === "up") return dy < 0;
      return dy > 0;
    })
    .map(({ id, dx, dy }) => {
      const primary = direction === "left" || direction === "right" ? Math.abs(dx) : Math.abs(dy);
      const cross = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
      return { id, score: cross * 10 + primary };
    })
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  return candidates[0]?.id ?? currentId;
}

function nodeAccent(state: CcflowState, node: CcflowNode): NodeAccent {
  const base: NodeAccent = {
    bar: COLOR_FOCUS_ACCENT,
    bg: "#0b1120",
    fg: COLOR_PRIMARY,
    dim: COLOR_TERTIARY,
  };
  if (ERROR_STATUSES.has(node.status)) {
    return { ...base, bar: COLOR_STATUS_ERROR };
  }
  if (node.type === "internal") {
    return { ...base, bar: COLOR_STATUS_SEALED };
  }
  const worktree = getWorktree(state, node.git.worktreeId);
  if (worktree.id === state.currentWorktreeId) {
    return { ...base, bar: COLOR_CURRENT_LEAF };
  }
  return { ...base, bar: COLOR_OTHER_LEAF };
}

function statusColor(status: string): string {
  if (status.includes("Failed") || status.includes("Conflict")) return COLOR_STATUS_ERROR;
  if (
    status.includes("Running") ||
    status.includes("Committing") ||
    status.includes("Merge") ||
    status === "Deleting"
  )
    return COLOR_STATUS_RUNNING;
  if (status.includes("Awaiting")) return COLOR_STATUS_AWAITING;
  if (status === "sealed") return COLOR_STATUS_SEALED;
  return "#cbd5e1";
}

function nodeIndicator(state: CcflowState, node: CcflowNode): string {
  if (ERROR_STATUSES.has(node.status)) return "◇";
  if (RUNNING_STATUSES.has(node.status)) return "◌";
  if (node.type === "internal") return "·";
  return "●";
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

/**
 * 按指定列宽对多段文本做按词换行；不折叠、不截断，长 commit body
 * 会在侧边面板内自动折成多行，每行都带 `│ ` 前缀。
 */
function wrapText(body: string, width: number): string[] {
  const max = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of body.split(/\r?\n/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    const words = trimmed.split(/\s+/);
    let current = "";
    for (const word of words) {
      if (!current) {
        current = word;
        continue;
      }
      if (current.length + 1 + word.length <= max) {
        current = `${current} ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}
