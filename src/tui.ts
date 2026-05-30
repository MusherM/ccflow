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
import { saveState } from "./core/storage.js";
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
import type { CcflowNode, CcflowState } from "./core/types.js";
import type { CcflowConfig } from "./core/config.js";

type Direction = "left" | "right" | "up" | "down";
type UiMode = "graph" | "detail";

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
    const exit = await runGraphOnce(state, ui, jobs, options.config);
    logEvent(state.repoRoot, "tui:graph:exit", {
      loop,
      kind: exit.kind,
      nodeId: exit.nodeId ?? null,
      focusId: ui.focusId,
    });
    if (exit.kind === "quit") return;
    if (exit.kind === "enter" && exit.nodeId) {
      await enterLeaf(state, exit.nodeId, ui, options.config);
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
      backgroundColor: "#070b10",
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
  const settle = (result: TuiExit) => {
    if (settled) return;
    settled = true;
    if (sessionPoll) clearInterval(sessionPoll);
    sessionPoll = null;
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

  const rerender = () => renderApp(renderer, state, ui);
  const persistAndSaveState = () => {
    persistUiPreferences(state, ui);
    saveState(state);
  };
  const reconcileAndSaveState = () => {
    if (!reconcileNodeSessionState(state)) return false;
    persistAndSaveState();
    return true;
  };
  const runAction = async (label: string, action: () => Promise<void> | void) => {
    if (ui.busy) return;
    ui.busy = true;
    ui.task = label;
    ui.message = label;
    rerender();
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await action();
      persistAndSaveState();
    } catch (error) {
      ui.message = error instanceof Error ? error.message : String(error);
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
        ui.message = node.blockedReason || node.error || `Node is not editable: ${node.status}`;
        rerender();
        return;
      }
      void runAction("opening node tab...", async () => {
        await enterLeaf(state, node.id, ui, config);
      });
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
          });
        },
        onCancel: () => {
          void runAction("creating sibling...", async () => {
            const sibling = await jobs.createSiblingNode(state, ensureUiFocus(state, ui).id, plan.defaultBranch ? { kind: "existing", branch: plan.defaultBranch } : undefined);
            ui.focusId = sibling.id;
            ui.selectedIds.clear();
            ui.mode = "graph";
            ui.message = `Created sibling ${sibling.id}`;
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
      });
      return;
    }

    if (key.sequence === "m") {
      if (ui.busy) return;
      ui.busy = true;
      ui.task = "merging...";
      ui.message = "merging...";
      rerender();
      (async () => {
        try {
          await new Promise<void>((r) => setTimeout(r, 0));
          const merge = await jobs.mergeLeaves(state, [...ui.selectedIds]);
          saveState(state);
          ui.focusId = merge.id;
          ui.selectedIds.clear();
          if (merge.status === "MergeConflict") {
            await enterLeaf(state, merge.id, ui, config);
            return;
          }
          ui.message = `Merge node ${merge.id}`;
        } catch (error) {
          ui.message = error instanceof Error ? error.message : String(error);
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
  ui: UiState,
  config?: CcflowConfig,
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
    logEvent(state.repoRoot, "tui:enter:attached", {
      nodeId: node.id,
      terminal: result.terminal,
    });
    ui.focusId = node.id;
    ui.message = `Opened ${node.id} in ${result.terminal === "iterm2" ? "iTerm2" : "Ghostty"} tab`;
    logEvent(state.repoRoot, "tui:enter:done", {
      nodeId: node.id,
      status: node.status,
      focusId: ui.focusId,
      sessionId: node.cc.sessionId,
      terminal: result.terminal,
    });
  } catch (error) {
    ui.message = error instanceof Error ? error.message : String(error);
    logEvent(state.repoRoot, "tui:enter:error", {
      nodeId: node.id,
      error: ui.message,
      focusId: ui.focusId,
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

function renderApp(renderer: CliRenderer, state: CcflowState, ui: UiState): void {
  try {
    renderer.root.remove("app");
  } catch {
    // First render has no app tree yet.
  }

  const width = Math.max(76, renderer.terminalWidth || renderer.width || 120);
  const height = Math.max(26, renderer.terminalHeight || renderer.height || 36);
  const compact = width < 116;
  const graphWidth = compact ? Math.max(70, width - 2) : Math.max(70, width - 40);
  const graphHeight = Math.max(19, height - 7);
  const focusNode = ensureUiFocus(state, ui);

  renderer.root.add(
    Box(
      {
        id: "app",
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: "#070b10",
      },
      toolbar(state, ui),
      Box(
        {
          flexGrow: 1,
          flexDirection: "row",
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 1,
          gap: 1,
        },
        ui.mode === "detail" ? detailPanel(state, focusNode, graphWidth, graphHeight) : graphPanel(state, ui, focusNode, graphWidth, graphHeight),
        compact ? compactSummary(state, focusNode, ui) : sidePanel(state, focusNode, ui),
      ),
      footer(ui),
    ),
  );

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
  ui.message = ui.message || `Focus moved to ${fallback.id}`;
  return fallback;
}

function restoreEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function toolbar(state: CcflowState, ui: UiState) {
  const current = getWorktree(state, state.currentWorktreeId);
  return Box(
    {
      height: 3,
      border: ["bottom"],
      borderStyle: "single",
      borderColor: "#1f2937",
      paddingLeft: 2,
      paddingRight: 2,
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: "#0f172a",
    },
    Text({
      content: "CCFlow  node graph  OpenTUI",
      fg: "#e5e7eb",
      attributes: TextAttributes.BOLD,
    }),
    Text({
      content: ui.task ? `task: ${ui.task}` : `${current.branch}  selected ${ui.selectedIds.size}`,
      fg: ui.task ? "#facc15" : ui.selectedIds.size ? "#facc15" : "#94a3b8",
    }),
  );
}

function graphPanel(state: CcflowState, ui: UiState, focusNode: CcflowNode, width: number, height: number) {
  const canvasWidth = width - 2;
  const canvasHeight = height - 2;
  const positions = layoutGraph(state);
  ui.graphViewport = ensureNodeVisible(ui.graphViewport, positions, focusNode.id, canvasWidth, canvasHeight);
  const edgeLayer = buildEdgeLayer(state, positions, canvasWidth, canvasHeight, ui.graphViewport);
  const visiblePositions = projectVisiblePositions(positions, ui.graphViewport, canvasWidth, canvasHeight);

  return Box(
    {
      width,
      height,
      border: true,
      borderStyle: "rounded",
      borderColor: "#334155",
      title: " node graph ",
      backgroundColor: "#020617",
      position: "relative",
      overflow: "hidden",
    },
    Text({
      content: edgeLayer,
      fg: "#334155",
      position: "absolute",
      left: 1,
      top: 1,
      width: canvasWidth,
      height: canvasHeight,
    }),
    ...visiblePositions.map((pos) =>
      nodeCard(state, pos.node, pos.x + 1, pos.y + 1, pos.width, ui.focusId === pos.node.id, ui.selectedIds.has(pos.node.id)),
    ),
  );
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
  const borderColor = focused ? "#7dd3fc" : selected ? "#facc15" : accent;
  const backgroundColor = focused ? "#7dd3fc" : selected ? "#3f3205" : "#0b1120";
  const fg = focused ? "#020617" : "#e5e7eb";
  const worktree = getWorktree(state, node.git.worktreeId);
  const indicator = nodeIndicator(state, node);
  const commit = node.git.commitHash ? node.git.commitHash.slice(0, 7) : "uncommitted";

  return Box(
    {
      position: "absolute",
      left,
      top,
      width,
      height: GRAPH_NODE_HEIGHT,
      border: true,
      borderStyle: "rounded",
      borderColor,
      backgroundColor,
      paddingLeft: 1,
      paddingRight: 1,
      flexDirection: "column",
    },
    Text({
      content: `${indicator} ${truncate(node.title, width - 6)}`,
      fg,
      attributes: focused ? TextAttributes.BOLD : TextAttributes.NONE,
    }),
    Text({ content: truncate(`${node.type} · ${node.status}`, width - 4), fg: focused ? "#0f172a" : accent }),
    Text({ content: truncate(`commit ${commit}  wt ${worktree.branch}`, width - 4), fg: focused ? "#0f172a" : "#94a3b8" }),
  );
}

function sidePanel(state: CcflowState, node: CcflowNode, ui: UiState) {
  const worktree = getWorktree(state, node.git.worktreeId);
  const accent = nodeAccent(state, node);
  const children = [
    Text({ content: node.title, fg: accent, attributes: TextAttributes.BOLD }),
    field("id", node.id),
    field("type", node.type, node.type === "leaf" ? "#facc15" : "#94a3b8"),
    field("status", node.status, statusColor(node.status)),
    field("branch", worktree.branch, accent),
    field(
      "worktree",
      worktree.locked ? `${worktree.status} locked` : worktree.status,
      worktree.locked ? "#7dd3fc" : worktree.status === "current" ? "#22c55e" : "#facc15",
    ),
    field("commit", node.git.commitHash?.slice(0, 12) ?? "none"),
    field("cc", node.status === "LeafRunning" ? "open tab" : node.cc.sessionId ? "resumable" : "none"),
    node.jobId ? field("job", node.jobId, "#7dd3fc") : null,
    node.pendingParentJobId ? field("parent job", node.pendingParentJobId, "#7dd3fc") : null,
    node.conflictFiles?.length ? field("conflicts", node.conflictFiles.join(", "), "#fb7185") : null,
    node.blockedReason ? field("blocked", node.blockedReason, "#facc15") : null,
    node.error ? field("error", node.error, "#fb7185") : null,
    Text({ content: "stats", fg: "#64748b" }),
    Text({
      content: `${node.stats.filesChanged} files  +${node.stats.insertions}  -${node.stats.deletions}`,
      fg: "#cbd5e1",
    }),
    Text({ content: truncate(worktree.path, 34), fg: "#94a3b8" }),
    Text({ content: ui.message || "Ready", fg: ui.busy ? "#facc15" : "#64748b", wrapMode: "word" }),
  ].filter((child) => child != null);
  return Box(
    {
      width: 36,
      height: "100%",
      border: true,
      borderStyle: "rounded",
      borderColor: accent,
      backgroundColor: "#0f172a",
      paddingLeft: 1,
      paddingRight: 1,
      flexDirection: "column",
      gap: 1,
    },
    ...children,
  );
}

function compactSummary(state: CcflowState, node: CcflowNode, ui: UiState) {
  const worktree = getWorktree(state, node.git.worktreeId);
  return Box(
    {
      position: "absolute",
      left: 2,
      bottom: 2,
      width: "95%",
      height: 4,
      border: true,
      borderStyle: "rounded",
      borderColor: nodeAccent(state, node),
      backgroundColor: "#0f172a",
      paddingLeft: 1,
      paddingRight: 1,
      flexDirection: "column",
    },
    Text({ content: `${node.title}  ${worktree.branch}`, fg: nodeAccent(state, node), attributes: TextAttributes.BOLD }),
    Text({ content: ui.message || `${node.type} ${node.status}`, fg: "#94a3b8" }),
  );
}

function detailPanel(state: CcflowState, node: CcflowNode, width: number, height: number) {
  const worktree = getWorktree(state, node.git.worktreeId);
  const lines = [
    `id: ${node.id}`,
    `title: ${node.title}`,
    `type: ${node.type}`,
    `status: ${node.status}`,
    `commit: ${node.git.commitHash ?? "none"}`,
    `branch: ${node.git.branch}`,
    `worktree: ${worktree.path}`,
    `parents: ${node.parents.join(", ") || "none"}`,
    `children: ${node.children.join(", ") || "none"}`,
    `cc session: ${node.cc.sessionId ?? "none"}`,
    `job: ${node.jobId ?? "none"}`,
    `parent job: ${node.pendingParentJobId ?? "none"}`,
    `blocked: ${node.blockedReason ?? "none"}`,
    `conflicts: ${node.conflictFiles?.join(", ") || "none"}`,
    `cc launch: new tab`,
    `files changed: ${node.stats.filesChanged}`,
    `insertions: ${node.stats.insertions}`,
    `deletions: ${node.stats.deletions}`,
    `symbols: ${node.stats.symbolsChanged.join(", ") || "none"}`,
    node.error ? `error: ${node.error}` : "",
  ].filter(Boolean);

  return Box(
    {
      width,
      height,
      border: true,
      borderStyle: "rounded",
      borderColor: nodeAccent(state, node),
      title: " node detail ",
      backgroundColor: "#020617",
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      flexDirection: "column",
    },
    ...lines.map((line, index) =>
      Text({ content: truncate(line, width - 6), fg: index === 1 ? nodeAccent(state, node) : "#cbd5e1" }),
    ),
  );
}

function footer(ui: UiState) {
  return Box(
    {
      height: 2,
      alignItems: "center",
      paddingLeft: 2,
      backgroundColor: "#070b10",
    },
    Text({
      content: ui.inputMode
        ? `${ui.inputMode.prompt}${ui.inputValue}█`
        : ui.mode === "detail"
          ? "esc graph   q quit"
          : "arrows/hjkl move   enter tab/detail   tab next   shift+tab sibling   space select   m merge   s switch   d delete leaf   q quit",
      fg: ui.inputMode ? "#7dd3fc" : "#94a3b8",
    }),
  );
}

function field(label: string, value: string, color = "#cbd5e1") {
  return Box(
    { flexDirection: "row" },
    Text({ content: label.padEnd(10), fg: "#64748b" }),
    Text({ content: value, fg: color }),
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

function nodeAccent(state: CcflowState, node: CcflowNode): string {
  if (node.status === "CommitFailed" || node.status === "MergeConflict" || node.status === "JobFailed") return "#fb7185";
  if (node.type === "internal") return "#64748b";
  const worktree = getWorktree(state, node.git.worktreeId);
  return worktree.id === state.currentWorktreeId ? "#22c55e" : "#facc15";
}

function statusColor(status: string): string {
  if (status.includes("Failed") || status.includes("Conflict")) return "#fb7185";
  if (status.includes("Running") || status.includes("Committing") || status.includes("Merge") || status === "Deleting") return "#7dd3fc";
  if (status.includes("Awaiting")) return "#facc15";
  if (status === "sealed") return "#94a3b8";
  return "#cbd5e1";
}

function nodeIndicator(state: CcflowState, node: CcflowNode): string {
  if (node.status === "CommitFailed" || node.status === "MergeConflict" || node.status === "JobFailed" || node.status === "ParentCommitFailed") return "◆";
  if (node.status === "LeafRunning" || node.status === "Committing" || node.status === "ParentCommitting" || node.status === "MergeRunning" || node.status === "Deleting") return "◌";
  if (node.status === "AwaitingParentCommit") return "◌";
  if (node.type === "internal") return "○";
  return getWorktree(state, node.git.worktreeId).id === state.currentWorktreeId ? "●" : "●";
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}
