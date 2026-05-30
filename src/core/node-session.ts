import fs from "node:fs";
import path from "node:path";
import { ClaudeAdapter } from "./claude.js";
import type { CcflowConfig } from "./config.js";
import { getNode, getWorktree, isLeafNode, switchCurrentWorktree } from "./graph.js";
import { logEvent } from "./log.js";
import { ensureCcflowDirs, loadState, saveSession, saveState } from "./storage.js";
import { buildNodeSessionCommand, openTerminalTab as defaultOpenTerminalTab, type OpenTerminalTabResult, type TerminalTabRequest } from "./terminal-tabs.js";
import type { CcflowNode, CcflowState } from "./types.js";

export interface NodeSessionLock {
  nodeId: string;
  pid: number | null;
  startedAt: string;
  terminal?: string | null;
  sessionId?: string | null;
}

export interface NodeSessionDeps {
  now?: () => string;
  pidIsAlive?: (pid: number) => boolean;
  pendingLockTtlMs?: number;
}

export interface LaunchNodeSessionDeps extends NodeSessionDeps {
  ccflowCommand?: string[];
  env?: NodeJS.ProcessEnv;
  openTerminalTab?: (request: TerminalTabRequest) => OpenTerminalTabResult;
}

export interface ClaudeInteractiveLike {
  attachOrResume(
    node: CcflowNode,
    cwd: string,
    repoRoot: string,
    config?: CcflowConfig,
  ): Promise<{ sessionId: string | null; alive: boolean }>;
}

export interface RunNodeSessionInput {
  repoRoot: string;
  nodeId: string;
  config: CcflowConfig;
  claude?: ClaudeInteractiveLike;
  now?: () => string;
  pid?: number;
}

export function nodeSessionLockPath(repoRoot: string, nodeId: string): string {
  return path.join(repoRoot, ".ccflow", "sessions", `${safeLockName(nodeId)}.lock.json`);
}

export function clearNodeSessionLock(repoRoot: string, nodeId: string): void {
  fs.rmSync(nodeSessionLockPath(repoRoot, nodeId), { force: true });
}

export function reconcileNodeSessionState(state: CcflowState, deps: NodeSessionDeps = {}): boolean {
  let changed = mergeSavedNodeSessionFields(state);
  for (const node of Object.values(state.nodes)) {
    if (!isLeafNode(state, node.id)) continue;
    const activeLock = readActiveNodeSessionLock(state.repoRoot, node.id, deps);
    if (activeLock) {
      changed = setNodeSessionRunning(node, activeLock) || changed;
      continue;
    }
    if (node.status === "LeafRunning") {
      node.status = node.cc.sessionId ? "LeafResumable" : "LeafNew";
      node.cc.processId = null;
      node.cc.resumeMode = node.cc.sessionId ? "resume" : "new";
      node.updatedAt = nowIso(deps);
      changed = true;
    }
  }
  return changed;
}

export async function launchNodeSessionTab(
  state: CcflowState,
  nodeId: string,
  config: CcflowConfig,
  deps: LaunchNodeSessionDeps = {},
): Promise<OpenTerminalTabResult> {
  reconcileNodeSessionState(state, deps);
  const node = getNode(state, nodeId);
  if (!isLeafNode(state, node.id)) throw new Error(`Only leaf nodes can be opened in a terminal tab: ${node.id}`);
  const worktree = getWorktree(state, node.git.worktreeId);
  const activeLock = readActiveNodeSessionLock(state.repoRoot, node.id, deps);
  if (activeLock) {
    throw new Error(`Node ${node.id} is already open in a terminal tab.`);
  }

  if (state.settings.worktree.enterLeafAutoSwitch) {
    switchCurrentWorktree(state, node.id);
  }

  const startedAt = nowIso(deps);
  node.status = "LeafRunning";
  node.cc.processId = null;
  node.cc.resumeMode = node.cc.sessionId ? "resume" : "new";
  node.error = null;
  node.updatedAt = startedAt;

  createNodeSessionLock(state.repoRoot, {
    nodeId: node.id,
    pid: null,
    startedAt,
    terminal: null,
    sessionId: node.cc.sessionId,
  }, deps);

  try {
    saveState(state);
    const request: TerminalTabRequest = {
      command: buildNodeSessionCommand({
        repoRoot: state.repoRoot,
        nodeId: node.id,
        ccflowCommand: deps.ccflowCommand,
        claudeBin: config.claude.bin,
        model: config.claude.model,
      }),
      cwd: worktree.path,
      title: `CCFlow ${node.id}`,
    };
    const open = deps.openTerminalTab ?? ((tabRequest: TerminalTabRequest) => defaultOpenTerminalTab(tabRequest, { env: deps.env }));
    const result = open(request);
    updateNodeSessionLock(state.repoRoot, node.id, { terminal: result.terminal });
    logEvent(state.repoRoot, "node-session:tab-opened", {
      nodeId: node.id,
      terminal: result.terminal,
      worktreePath: worktree.path,
    });
    return result;
  } catch (error) {
    clearNodeSessionLock(state.repoRoot, node.id);
    node.status = node.cc.sessionId ? "LeafResumable" : "LeafNew";
    node.cc.processId = null;
    node.cc.resumeMode = node.cc.sessionId ? "resume" : "new";
    node.error = error instanceof Error ? error.message : String(error);
    node.updatedAt = nowIso(deps);
    saveState(state);
    throw error;
  }
}

export async function runNodeSessionInCurrentTerminal(input: RunNodeSessionInput): Promise<number> {
  const now = input.now ?? (() => new Date().toISOString());
  const pid = input.pid ?? process.pid;
  const claude = input.claude ?? new ClaudeAdapter();
  updateNodeSessionLock(input.repoRoot, input.nodeId, {
    pid,
    startedAt: now(),
  });

  let state = loadState(input.repoRoot);
  let node = getNode(state, input.nodeId);
  const worktree = getWorktree(state, node.git.worktreeId);
  node.status = "LeafRunning";
  node.cc.processId = pid;
  node.cc.resumeMode = node.cc.sessionId ? "resume" : "new";
  node.updatedAt = now();
  saveState(state);

  try {
    const result = await claude.attachOrResume(node, worktree.path, input.repoRoot, input.config);
    state = loadState(input.repoRoot);
    node = getNode(state, input.nodeId);
    node.cc.sessionId = result.sessionId;
    node.cc.processId = null;
    node.cc.resumeMode = result.sessionId ? "resume" : "new";
    node.status = result.sessionId ? "LeafResumable" : "LeafNew";
    node.updatedAt = now();
    saveSession(input.repoRoot, node);
    saveState(state);
    logEvent(input.repoRoot, "node-session:done", {
      nodeId: node.id,
      sessionId: node.cc.sessionId,
    });
    return 0;
  } catch (error) {
    state = loadState(input.repoRoot);
    node = getNode(state, input.nodeId);
    node.status = "JobFailed";
    node.cc.processId = null;
    node.error = error instanceof Error ? error.message : String(error);
    node.updatedAt = now();
    saveState(state);
    logEvent(input.repoRoot, "node-session:error", {
      nodeId: node.id,
      error: node.error,
    });
    return 1;
  } finally {
    clearNodeSessionLock(input.repoRoot, input.nodeId);
  }
}

function createNodeSessionLock(repoRoot: string, lock: NodeSessionLock, deps: NodeSessionDeps): void {
  ensureCcflowDirs(repoRoot);
  const existing = readActiveNodeSessionLock(repoRoot, lock.nodeId, deps);
  if (existing) throw new Error(`Node ${lock.nodeId} is already open in a terminal tab.`);
  fs.writeFileSync(nodeSessionLockPath(repoRoot, lock.nodeId), `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx" });
}

function updateNodeSessionLock(repoRoot: string, nodeId: string, patch: Partial<NodeSessionLock>): void {
  ensureCcflowDirs(repoRoot);
  const file = nodeSessionLockPath(repoRoot, nodeId);
  const existing = readNodeSessionLock(repoRoot, nodeId) ?? { nodeId, pid: null, startedAt: new Date().toISOString() };
  fs.writeFileSync(file, `${JSON.stringify({ ...existing, ...patch, nodeId }, null, 2)}\n`);
}

function readActiveNodeSessionLock(repoRoot: string, nodeId: string, deps: NodeSessionDeps = {}): NodeSessionLock | null {
  const lock = readNodeSessionLock(repoRoot, nodeId);
  if (!lock) return null;
  if (lock.pid && pidIsAlive(lock.pid, deps)) return lock;
  if (!lock.pid && pendingLockStillFresh(lock, deps)) return lock;
  clearNodeSessionLock(repoRoot, nodeId);
  return null;
}

function readNodeSessionLock(repoRoot: string, nodeId: string): NodeSessionLock | null {
  const file = nodeSessionLockPath(repoRoot, nodeId);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<NodeSessionLock>;
    if (parsed.nodeId !== nodeId) return null;
    return {
      nodeId,
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : new Date(0).toISOString(),
      terminal: parsed.terminal ?? null,
      sessionId: parsed.sessionId ?? null,
    };
  } catch {
    clearNodeSessionLock(repoRoot, nodeId);
    return null;
  }
}

function pendingLockStillFresh(lock: NodeSessionLock, deps: NodeSessionDeps): boolean {
  const ttl = deps.pendingLockTtlMs ?? 30_000;
  const started = Date.parse(lock.startedAt);
  if (!Number.isFinite(started)) return false;
  const current = Date.parse(nowIso(deps));
  return current - started <= ttl;
}

function pidIsAlive(pid: number, deps: NodeSessionDeps): boolean {
  if (deps.pidIsAlive) return deps.pidIsAlive(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function setNodeSessionRunning(node: CcflowNode, lock: NodeSessionLock): boolean {
  let changed = false;
  if (node.status !== "LeafRunning") {
    node.status = "LeafRunning";
    changed = true;
  }
  const nextProcessId = lock.pid ?? null;
  if (node.cc.processId !== nextProcessId) {
    node.cc.processId = nextProcessId;
    changed = true;
  }
  const nextResumeMode = node.cc.sessionId ? "resume" : "new";
  if (node.cc.resumeMode !== nextResumeMode) {
    node.cc.resumeMode = nextResumeMode;
    changed = true;
  }
  return changed;
}

function mergeSavedNodeSessionFields(state: CcflowState): boolean {
  let saved: CcflowState;
  try {
    saved = loadState(state.repoRoot);
  } catch {
    return false;
  }

  let changed = false;
  for (const node of Object.values(state.nodes)) {
    const savedNode = saved.nodes[node.id];
    if (!savedNode || savedNode.updatedAt <= node.updatedAt) continue;
    node.cc = structuredClone(savedNode.cc);
    node.status = savedNode.status;
    node.error = savedNode.error ?? null;
    node.blockedReason = savedNode.blockedReason ?? null;
    node.updatedAt = savedNode.updatedAt;
    changed = true;
  }
  return changed;
}

function nowIso(deps: NodeSessionDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}

function safeLockName(nodeId: string): string {
  return nodeId.replace(/[^A-Za-z0-9_.-]/g, "_");
}
