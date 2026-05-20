import {
  Box,
  Text,
  TextAttributes,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { ClaudeAdapter } from "./core/claude.js";
import { GitAdapter } from "./core/git.js";
import { getNode, getWorktree, isLeafNode, switchCurrentWorktree } from "./core/graph.js";
import { JobRunner } from "./core/jobs.js";
import { saveSession, saveState } from "./core/storage.js";
import { quarantineTerminalInput, releaseStdinForChildProcess, resetTerminalForChildProcess } from "./core/terminal.js";
import type { CcflowNode, CcflowState } from "./core/types.js";

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
  inputMode: InputMode | null;
  inputValue: string;
}

interface TuiExit {
  kind: "quit" | "enter";
  nodeId?: string;
}

interface PositionedNode {
  node: CcflowNode;
  x: number;
  y: number;
  width: number;
  height: number;
  lane: number;
  row: number;
}

export async function runCcflowTui(state: CcflowState): Promise<void> {
  const git = new GitAdapter();
  const claude = new ClaudeAdapter();
  const jobs = new JobRunner(git, claude);
  const ui: UiState = {
    focusId: state.currentNodeId,
    selectedIds: new Set(),
    mode: "graph",
    message: "",
    task: null,
    busy: false,
    inputMode: null,
    inputValue: "",
  };

  while (true) {
    refreshDirtyStatuses(state, git);
    const exit = await runGraphOnce(state, ui, jobs);
    if (exit.kind === "quit") return;
    if (exit.kind === "enter" && exit.nodeId) {
      await enterLeaf(state, exit.nodeId, claude, ui);
    }
  }
}

async function runGraphOnce(
  state: CcflowState,
  ui: UiState,
  jobs: JobRunner,
): Promise<TuiExit> {
  const previousOpenTuiGraphics = process.env.OPENTUI_GRAPHICS;
  process.env.OPENTUI_GRAPHICS = "false";
  let renderer: CliRenderer;
  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: true,
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
  } finally {
    restoreEnvValue("OPENTUI_GRAPHICS", previousOpenTuiGraphics);
  }
  renderer.disableKittyKeyboard();

  let settled = false;
  const settle = (result: TuiExit) => {
    if (settled) return;
    settled = true;
    void (async () => {
      renderer.disableKittyKeyboard();
      renderer.suspend();
      const destroyed = new Promise<void>((resolve) => renderer.once("destroy", () => resolve()));
      renderer.destroy();
      await destroyed;
      resetTerminalForChildProcess();
      await quarantineTerminalInput();
      releaseStdinForChildProcess();
      resetTerminalForChildProcess();
      resolve(result);
    })();
  };

  let resolve!: (value: TuiExit) => void;
  const done = new Promise<TuiExit>((innerResolve) => {
    resolve = innerResolve;
  });

  const rerender = () => renderApp(renderer, state, ui);
  const runAction = async (label: string, action: () => Promise<void> | void) => {
    if (ui.busy) return;
    ui.busy = true;
    ui.task = label;
    ui.message = label;
    rerender();
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await action();
      saveState(state);
    } catch (error) {
      ui.message = error instanceof Error ? error.message : String(error);
    } finally {
      ui.busy = false;
      ui.task = null;
      rerender();
    }
  };

  renderer.keyInput.on("keypress", (key) => {
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

    if (ui.busy) return;
    const direction = keyToDirection(key);
    if (direction && ui.mode === "graph") {
      ui.focusId = moveFocus(state, ui.focusId, direction);
      rerender();
      key.preventDefault();
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      const node = getNode(state, ui.focusId);
      if (!isLeafNode(state, node.id)) {
        ui.mode = "detail";
        rerender();
        return;
      }
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
      saveState(state);
      settle({ kind: "quit" });
      return;
    }

    if (isShiftTab(key)) {
      ui.inputMode = {
        prompt: "Branch name (enter=confirm, esc=default): ",
        onConfirm: (value: string) => {
          void runAction("creating sibling...", async () => {
            const sibling = await jobs.createSiblingNode(state, ui.focusId, value || undefined);
            ui.focusId = sibling.id;
            ui.selectedIds.clear();
            ui.mode = "graph";
            ui.message = `Created sibling ${sibling.id}`;
          });
        },
        onCancel: () => {
          void runAction("creating sibling...", async () => {
            const sibling = await jobs.createSiblingNode(state, ui.focusId);
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
      void runAction("committing... creating next node...", async () => {
        const child = await jobs.createNextNode(state, ui.focusId);
        ui.focusId = child.id;
        ui.selectedIds.clear();
        ui.mode = "graph";
        ui.message = `Created ${child.id}`;
      });
      key.preventDefault();
      return;
    }

    if (key.sequence === "d") {
      void runAction("deleting leaf... resetting worktree...", async () => {
        const focus = await jobs.deleteLeaf(state, ui.focusId);
        ui.focusId = focus.id;
        ui.selectedIds.delete(ui.focusId);
        ui.selectedIds.clear();
        ui.mode = "graph";
        ui.message = `Deleted leaf; reset to ${focus.id}`;
      });
      return;
    }

    if (key.name === "space" || key.sequence === " ") {
      const node = getNode(state, ui.focusId);
      if (isLeafNode(state, node.id)) {
        if (ui.selectedIds.has(node.id)) ui.selectedIds.delete(node.id);
        else ui.selectedIds.add(node.id);
      }
      rerender();
      return;
    }

    if (key.sequence === "s") {
      void runAction("Switching worktree", () => {
        const worktree = switchCurrentWorktree(state, ui.focusId);
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
            settle({ kind: "enter", nodeId: merge.id });
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
      settled = true;
      resolve({ kind: "quit" });
    }
  });

  rerender();
  renderer.start();
  return done;
}

async function enterLeaf(
  state: CcflowState,
  nodeId: string,
  claude: ClaudeAdapter,
  ui: UiState,
): Promise<void> {
  const node = getNode(state, nodeId);
  const worktree = getWorktree(state, node.git.worktreeId);
  if (state.settings.worktree.enterLeafAutoSwitch) {
    switchCurrentWorktree(state, node.id);
  }

  node.status = "LeafRunning";
  node.cc.resumeMode = node.cc.sessionId ? "resume" : "new";
  node.updatedAt = new Date().toISOString();
  saveState(state);

  try {
    const result = await claude.attachOrResume(node, worktree.path);
    node.cc.sessionId = result.sessionId;
    node.cc.processId = null;
    node.cc.resumeMode = result.sessionId ? "resume" : "new";
    node.status = result.sessionId ? "LeafResumable" : "LeafNew";
    node.updatedAt = new Date().toISOString();
    saveSession(state.repoRoot, node);
    saveState(state);
    ui.focusId = node.id;
    ui.message = "Claude session ended";
  } catch (error) {
    node.status = "JobFailed";
    node.error = error instanceof Error ? error.message : String(error);
    saveState(state);
    ui.message = node.error ?? "Failed to enter Claude";
  }
}

function refreshDirtyStatuses(state: CcflowState, git: GitAdapter): void {
  for (const node of Object.values(state.nodes)) {
    if (!isLeafNode(state, node.id)) continue;
    if (node.locked || node.status === "LeafRunning" || node.status === "LeafSuspended") continue;
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
  const focusNode = getNode(state, ui.focusId);

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
        ui.mode === "detail" ? detailPanel(state, focusNode, graphWidth, graphHeight) : graphPanel(state, ui, graphWidth, graphHeight),
        compact ? compactSummary(state, focusNode, ui) : sidePanel(state, focusNode, ui),
      ),
      footer(ui),
    ),
  );

  renderer.requestRender();
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

function graphPanel(state: CcflowState, ui: UiState, width: number, height: number) {
  const positions = layoutGraph(state, width - 2, height - 2);
  const edgeLayer = buildEdgeLayer(state, positions, width - 2, height - 2);

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
    },
    Text({
      content: edgeLayer,
      fg: "#334155",
      position: "absolute",
      left: 1,
      top: 1,
      width: width - 2,
      height: height - 2,
    }),
    ...positions.map((pos) =>
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
      height: 6,
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
    Text({ content: truncate(`commit ${commit}`, width - 4), fg: focused ? "#0f172a" : "#94a3b8" }),
    Text({ content: truncate(`wt ${worktree.branch}`, width - 4), fg: focused ? "#0f172a" : "#cbd5e1" }),
  );
}

function sidePanel(state: CcflowState, node: CcflowNode, ui: UiState) {
  const worktree = getWorktree(state, node.git.worktreeId);
  const accent = nodeAccent(state, node);
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
    field("cc", node.cc.sessionId ? "resumable" : "none"),
    Text({ content: "stats", fg: "#64748b" }),
    Text({
      content: `${node.stats.filesChanged} files  +${node.stats.insertions}  -${node.stats.deletions}`,
      fg: "#cbd5e1",
    }),
    Text({ content: truncate(worktree.path, 34), fg: "#94a3b8" }),
    Text({ content: ui.message || "Ready", fg: ui.busy ? "#facc15" : "#64748b", wrapMode: "word" }),
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
    `cc launch: direct`,
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
          : "arrows/hjkl move   enter open/detail   tab next   shift+tab sibling   space select   m merge   s switch   d delete leaf   q quit",
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

function layoutGraph(state: CcflowState, width: number, height: number): PositionedNode[] {
  const ranked = rankNodes(state);
  const maxLane = Math.max(0, ...[...ranked.values()].map((rank) => rank.lane));
  const maxRowsByLane = new Map<number, number>();
  for (const rank of ranked.values()) {
    maxRowsByLane.set(rank.lane, Math.max(maxRowsByLane.get(rank.lane) ?? 0, rank.row));
  }

  const nodeWidth = Math.max(18, Math.min(28, Math.floor((width - 4) / Math.max(1, maxLane + 1)) - 2));
  const nodeHeight = 6;
  const maxX = Math.max(1, width - nodeWidth - 2);
  const maxY = Math.max(1, height - nodeHeight - 2);
  return Object.values(state.nodes)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((node) => {
      const rank = ranked.get(node.id) ?? { lane: 0, row: 0 };
      const rowCount = (maxRowsByLane.get(rank.lane) ?? 0) + 1;
      return {
        node,
        x: Math.round(maxLane === 0 ? 1 : (maxX * rank.lane) / maxLane),
        y: Math.round(rowCount <= 1 ? maxY / 2 : (maxY * rank.row) / (rowCount - 1)),
        width: nodeWidth,
        height: nodeHeight,
        lane: rank.lane,
        row: rank.row,
      };
    });
}

function rankNodes(state: CcflowState): Map<string, { lane: number; row: number }> {
  const nodes = Object.values(state.nodes).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const depthCache = new Map<string, number>();
  const depthOf = (node: CcflowNode): number => {
    const cached = depthCache.get(node.id);
    if (cached !== undefined) return cached;
    const depth = node.parents.length
      ? Math.max(...node.parents.map((parentId) => depthOf(getNode(state, parentId)))) + 1
      : 0;
    depthCache.set(node.id, depth);
    return depth;
  };
  const byLane = new Map<number, CcflowNode[]>();
  for (const node of nodes) {
    const lane = depthOf(node);
    const laneNodes = byLane.get(lane) ?? [];
    laneNodes.push(node);
    byLane.set(lane, laneNodes);
  }
  const ranked = new Map<string, { lane: number; row: number }>();
  for (const [lane, laneNodes] of byLane) {
    laneNodes.forEach((node, row) => ranked.set(node.id, { lane, row }));
  }
  return ranked;
}

function buildEdgeLayer(state: CcflowState, positions: PositionedNode[], width: number, height: number): string {
  const cells = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
  const byId = new Map(positions.map((position) => [position.node.id, position]));
  for (const node of Object.values(state.nodes)) {
    const from = byId.get(node.id);
    if (!from) continue;
    for (const childId of node.children) {
      const to = byId.get(childId);
      if (!to) continue;
      drawEdge(cells, from, to);
    }
  }
  return cells.map((row) => row.join("")).join("\n");
}

function drawEdge(cells: string[][], from: PositionedNode, to: PositionedNode): void {
  const startX = from.x + from.width;
  const startY = from.y + Math.floor(from.height / 2);
  const endX = to.x - 1;
  const endY = to.y + Math.floor(to.height / 2);
  const midX = Math.max(startX + 1, Math.floor((startX + endX) / 2));
  drawHorizontal(cells, startX, midX, startY);
  drawVertical(cells, midX, startY, endY);
  drawHorizontal(cells, midX, endX, endY);
  setCell(cells, endX, endY, ">");
}

function drawHorizontal(cells: string[][], x1: number, x2: number, y: number): void {
  for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x += 1) setCell(cells, x, y, "-");
}

function drawVertical(cells: string[][], x: number, y1: number, y2: number): void {
  for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y += 1) setCell(cells, x, y, "|");
}

function setCell(cells: string[][], x: number, y: number, value: string): void {
  if (y < 0 || y >= cells.length || x < 0 || x >= cells[y].length) return;
  cells[y][x] = value;
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
  if (status === "sealed") return "#94a3b8";
  return "#cbd5e1";
}

function nodeIndicator(state: CcflowState, node: CcflowNode): string {
  if (node.status === "CommitFailed" || node.status === "MergeConflict" || node.status === "JobFailed") return "◆";
  if (node.status === "LeafRunning" || node.status === "Committing" || node.status === "MergeRunning" || node.status === "Deleting") return "◌";
  if (node.type === "internal") return "○";
  return getWorktree(state, node.git.worktreeId).id === state.currentWorktreeId ? "●" : "●";
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}
