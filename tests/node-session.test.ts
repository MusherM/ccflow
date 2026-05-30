import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultCcflowConfig } from "../src/core/config.js";
import { createInitialState, sealLeafAndCreateChild } from "../src/core/graph.js";
import {
  clearNodeSessionLock,
  launchNodeSessionTab,
  nodeSessionLockPath,
  reconcileNodeSessionState,
  runNodeSessionInCurrentTerminal,
} from "../src/core/node-session.js";
import { loadState, saveState, statePath } from "../src/core/storage.js";
import type { CcflowState } from "../src/core/types.js";

test("launchNodeSessionTab marks a node running, opens a terminal tab, and blocks duplicates", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-node-session-launch-"));
  const state = createState(repoRoot);
  const config = defaultCcflowConfig();
  const opened: Array<{ command: string; cwd: string; title?: string }> = [];

  const launched = await launchNodeSessionTab(state, state.currentNodeId, config, {
    now: () => "2026-05-30T00:00:00.000Z",
    ccflowCommand: ["/bin/ccflow-test"],
    openTerminalTab: (request) => {
      opened.push(request);
      return { terminal: "iterm2" };
    },
    env: { TERM_PROGRAM: "iTerm.app" },
  });

  const node = state.nodes[state.currentNodeId]!;
  assert.equal(launched.terminal, "iterm2");
  assert.equal(opened.length, 1);
  assert.match(opened[0]?.command ?? "", /__node-session/);
  assert.match(opened[0]?.command ?? "", /--node/);
  assert.equal(opened[0]?.cwd, repoRoot);
  assert.equal(opened[0]?.title, `CCFlow ${node.id}`);
  assert.equal(node.status, "LeafRunning");
  assert.equal(node.cc.resumeMode, "new");
  assert.equal(fs.existsSync(nodeSessionLockPath(repoRoot, node.id)), true);

  await assert.rejects(
    () =>
      launchNodeSessionTab(state, node.id, config, {
        now: () => "2026-05-30T00:00:01.000Z",
        openTerminalTab: () => {
          throw new Error("should not open duplicate");
        },
        pidIsAlive: () => true,
      }),
    /already open/,
  );
});

test("launchNodeSessionTab clears state and lock when terminal launch fails", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-node-session-fail-"));
  const state = createState(repoRoot);
  const nodeId = state.currentNodeId;

  await assert.rejects(
    () =>
      launchNodeSessionTab(state, nodeId, defaultCcflowConfig(), {
        now: () => "2026-05-30T00:00:00.000Z",
        openTerminalTab: () => {
          throw new Error("terminal denied automation");
        },
      }),
    /terminal denied automation/,
  );

  assert.equal(state.nodes[nodeId]?.status, "LeafNew");
  assert.equal(fs.existsSync(nodeSessionLockPath(repoRoot, nodeId)), false);
  assert.equal(loadState(repoRoot).nodes[nodeId]?.status, "LeafNew");
});

test("reconcileNodeSessionState refreshes finished sessions and removes stale locks", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-node-session-reconcile-"));
  const state = createState(repoRoot);
  const nodeId = state.currentNodeId;
  const disk = structuredClone(state) as CcflowState;
  disk.nodes[nodeId]!.status = "LeafResumable";
  disk.nodes[nodeId]!.cc.sessionId = "session-from-tab";
  disk.nodes[nodeId]!.cc.resumeMode = "resume";
  disk.nodes[nodeId]!.updatedAt = "2026-05-30T00:00:01.000Z";
  saveState(disk);

  fs.writeFileSync(
    nodeSessionLockPath(repoRoot, nodeId),
    `${JSON.stringify({ nodeId, pid: 12345, startedAt: "2026-05-30T00:00:00.000Z" })}\n`,
  );

  const changed = reconcileNodeSessionState(state, { pidIsAlive: () => false });

  assert.equal(changed, true);
  assert.equal(state.nodes[nodeId]?.status, "LeafResumable");
  assert.equal(state.nodes[nodeId]?.cc.sessionId, "session-from-tab");
  assert.equal(fs.existsSync(nodeSessionLockPath(repoRoot, nodeId)), false);
});

test("reconcileNodeSessionState keeps active locks visible as running nodes", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-node-session-active-"));
  const state = createState(repoRoot);
  const nodeId = state.currentNodeId;

  fs.writeFileSync(
    nodeSessionLockPath(repoRoot, nodeId),
    `${JSON.stringify({ nodeId, pid: 42, startedAt: "2026-05-30T00:00:00.000Z" })}\n`,
  );

  const changed = reconcileNodeSessionState(state, { pidIsAlive: (pid) => pid === 42 });

  assert.equal(changed, true);
  assert.equal(state.nodes[nodeId]?.status, "LeafRunning");
  assert.equal(state.nodes[nodeId]?.cc.processId, 42);

  clearNodeSessionLock(repoRoot, nodeId);
});

test("reconcileNodeSessionState drops malformed and mismatched lock files", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-node-session-bad-lock-"));
  const state = createState(repoRoot);
  const nodeId = state.currentNodeId;
  const lockFile = nodeSessionLockPath(repoRoot, nodeId);

  fs.writeFileSync(lockFile, "{bad json\n");
  assert.equal(reconcileNodeSessionState(state), false);
  assert.equal(fs.existsSync(lockFile), false);

  fs.writeFileSync(lockFile, `${JSON.stringify({ nodeId: "other", pid: 42, startedAt: "2026-05-30T00:00:00.000Z" })}\n`);
  assert.equal(reconcileNodeSessionState(state, { pidIsAlive: () => true }), false);
  assert.equal(state.nodes[nodeId]?.status, "LeafNew");
});

test("launchNodeSessionTab rejects non-leaf nodes before opening a terminal", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-node-session-internal-"));
  const state = createState(repoRoot);
  const rootId = state.currentNodeId;
  sealLeafAndCreateChild(state, {
    leafId: rootId,
    commitHash: "next",
    commitMessage: "next",
    sessionId: null,
    stats: { filesChanged: 0, insertions: 0, deletions: 0, symbolsChanged: [] },
    idFactory: (prefix) => `${prefix}_child`,
  });
  saveState(state);

  await assert.rejects(
    () =>
      launchNodeSessionTab(state, rootId, defaultCcflowConfig(), {
        openTerminalTab: () => {
          throw new Error("should not open");
        },
      }),
    /Only leaf nodes/,
  );
});

test("runNodeSessionInCurrentTerminal updates the node from the interactive Claude result", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-node-session-runner-"));
  const state = createState(repoRoot);
  const nodeId = state.currentNodeId;
  const calls: Array<{ nodeId: string; cwd: string; repoRoot: string }> = [];

  fs.writeFileSync(
    nodeSessionLockPath(repoRoot, nodeId),
    `${JSON.stringify({ nodeId, pid: null, startedAt: "2026-05-30T00:00:00.000Z" })}\n`,
  );

  const code = await runNodeSessionInCurrentTerminal({
    repoRoot,
    nodeId,
    config: defaultCcflowConfig(),
    now: () => "2026-05-30T00:00:02.000Z",
    pid: 9876,
    claude: {
      attachOrResume: async (node, cwd, root) => {
        calls.push({ nodeId: node.id, cwd, repoRoot: root });
        return { sessionId: "session-after-tab", alive: false };
      },
    },
  });

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.cwd, repoRoot);
  assert.equal(fs.existsSync(nodeSessionLockPath(repoRoot, nodeId)), false);

  const saved = JSON.parse(fs.readFileSync(statePath(repoRoot), "utf8")) as CcflowState;
  assert.equal(saved.nodes[nodeId]?.status, "LeafResumable");
  assert.equal(saved.nodes[nodeId]?.cc.sessionId, "session-after-tab");
  assert.equal(saved.nodes[nodeId]?.cc.processId, null);
});

test("runNodeSessionInCurrentTerminal records Claude launch failures and clears the lock", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-node-session-error-"));
  const state = createState(repoRoot);
  const nodeId = state.currentNodeId;

  fs.writeFileSync(
    nodeSessionLockPath(repoRoot, nodeId),
    `${JSON.stringify({ nodeId, pid: null, startedAt: "2026-05-30T00:00:00.000Z" })}\n`,
  );

  const code = await runNodeSessionInCurrentTerminal({
    repoRoot,
    nodeId,
    config: defaultCcflowConfig(),
    now: () => "2026-05-30T00:00:03.000Z",
    pid: 123,
    claude: {
      attachOrResume: async () => {
        throw new Error("claude failed");
      },
    },
  });

  const saved = loadState(repoRoot);
  assert.equal(code, 1);
  assert.equal(saved.nodes[nodeId]?.status, "JobFailed");
  assert.equal(saved.nodes[nodeId]?.error, "claude failed");
  assert.equal(fs.existsSync(nodeSessionLockPath(repoRoot, nodeId)), false);
});

function createState(repoRoot: string): CcflowState {
  const state = createInitialState({
    repoRoot,
    branch: "main",
    commitHash: "root",
    now: "2026-05-30T00:00:00.000Z",
    idFactory: (prefix) => `${prefix}_root`,
  });
  saveState(state);
  return state;
}
