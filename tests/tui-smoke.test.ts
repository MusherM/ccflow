import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { GitAdapter } from "../src/core/git.js";
import { createPendingChildFromLeaf, sealLeafAndCreateChild } from "../src/core/graph.js";
import { JobRunner } from "../src/core/jobs.js";
import { loadOrInitState, saveState, statePath } from "../src/core/storage.js";
import { emptyStats, type CcflowState } from "../src/core/types.js";
import { claudeCliConfig, requirePython3, withClaudeSettingsSnapshot } from "./helpers/claude-cli.js";

test("TUI delete key removes the current latest leaf and preserves one current worktree", async () => {
  requirePython3();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-tui-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "initial\n");
  git.commit(repoRoot, "test: initial readme");
  const state = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });
  const runner = new JobRunner(git);
  const latest = await runner.createNextNode(state, state.currentNodeId);

  const result = runTuiPty(repoRoot, [
    { sequence: "d", delay: 1.5 },
    { sequence: "q", delay: 0.5 },
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const finalState = JSON.parse(fs.readFileSync(statePath(repoRoot), "utf8")) as CcflowState;
  const currentWorktrees = Object.values(finalState.worktrees).filter((worktree) => worktree.status === "current");

  assert.equal(finalState.nodes[latest.id], undefined);
  assert.equal(currentWorktrees.length, 1);
  assert.equal(currentWorktrees[0]?.id, finalState.currentWorktreeId);
  assert.equal(finalState.nodes[finalState.currentNodeId]?.type, "leaf");
});

test("TUI tab creates a new leaf and delegates README commit to Claude Code", async () => {
  requirePython3();
  const claude = claudeCliConfig();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-tui-commit-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "initial\n");
  git.commit(repoRoot, "test: initial readme");
  loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });

  const beforeCommit = git.currentCommit(repoRoot);
  fs.appendFileSync(path.join(repoRoot, "README.md"), "updated before Claude TUI commit\n");

  const result = withClaudeSettingsSnapshot(() =>
    runTuiPty(
      repoRoot,
      [
        { sequence: "\t", delay: 300, waitForNodeCount: 2 },
        { sequence: "q", delay: 0.5 },
      ],
      claude.env,
      360000,
    ),
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const finalState = JSON.parse(fs.readFileSync(statePath(repoRoot), "utf8")) as CcflowState;
  const nodes = Object.values(finalState.nodes);
  const root = nodes.find((node) => node.parents.length === 0);
  const leaves = nodes.filter((node) => node.type === "leaf");

  assert.equal(nodes.length, 2);
  assert.equal(root?.type, "internal");
  assert.equal(root?.status, "sealed");
  assert.equal(leaves.length, 1);
  assert.equal(finalState.currentNodeId, leaves[0]?.id);
  assert.equal(git.hasDirtyChanges(repoRoot), false);
  assert.notEqual(git.currentCommit(repoRoot), beforeCommit);
  assert.ok(git.lastCommitMessage(repoRoot).length > 0);
  assert.match(fs.readFileSync(path.join(repoRoot, "README.md"), "utf8"), /updated before Claude TUI commit/);
});

test("TUI shows blocked state instead of entering a pending child", () => {
  requirePython3();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-tui-locked-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "initial\n");
  git.commit(repoRoot, "test: initial readme");
  const state = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });
  const child = createPendingChildFromLeaf(state, {
    leafId: state.currentNodeId,
    jobId: "job_commit_smoke",
  });
  state.worktrees[child.git.worktreeId]!.locked = true;
  saveState(state);

  const result = runTuiPty(repoRoot, [
    { sequence: "\r", delay: 5, waitForOutputText: "Interrupted job requires retry" },
    { sequence: "q", delay: 0.5 },
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const finalState = JSON.parse(fs.readFileSync(statePath(repoRoot), "utf8")) as CcflowState;
  assert.equal(finalState.currentNodeId, child.id);
  assert.equal(finalState.nodes[child.id]?.status, "ParentCommitFailed");
});

test("TUI persists graph focus and pans the viewport to the focused node", () => {
  requirePython3();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-tui-viewport-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "initial\n");
  git.commit(repoRoot, "test: initial readme");
  const state = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });
  const rootId = state.currentNodeId;
  let leafId = rootId;

  for (let index = 1; index <= 6; index += 1) {
    const child = sealLeafAndCreateChild(state, {
      leafId,
      commitHash: `commit_${index}`,
      commitMessage: `step ${index}`,
      sessionId: null,
      stats: emptyStats(),
      now: `2026-05-22T00:00:${String(index).padStart(2, "0")}.000Z`,
      idFactory: () => `node_${index}`,
    });
    leafId = child.id;
  }
  state.ui = {
    focusNodeId: rootId,
    graphViewport: { x: 0, y: 0 },
  };
  saveState(state);

  const result = runTuiPty(repoRoot, [
    { sequence: "l", delay: 0.1 },
    { sequence: "l", delay: 0.1 },
    { sequence: "l", delay: 0.1 },
    { sequence: "l", delay: 0.1 },
    { sequence: "l", delay: 0.1 },
    { sequence: "l", delay: 0.1 },
    { sequence: "q", delay: 0.5 },
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const finalState = JSON.parse(fs.readFileSync(statePath(repoRoot), "utf8")) as CcflowState;
  assert.equal(finalState.ui?.focusNodeId, leafId);
  assert.ok((finalState.ui?.graphViewport?.x ?? 0) > 0);
});

function runTuiPty(
  repoRoot: string,
  keys: Array<{
    sequence: string;
    delay: number;
    waitForNodeCount?: number;
    waitForFile?: string;
    waitForOutputText?: string;
    waitForFileText?: { path: string; text: string };
    injectAfterMs?: number;
    injectSequence?: string;
  }>,
  extraEnv: NodeJS.ProcessEnv = process.env,
  timeout = 15000,
  options: { allowTerminateAfterKeys?: boolean } = {},
): SpawnSyncReturns<string> {
  return spawnSync("python3", ["-c", ptyDriverSource(), repoRoot, process.cwd(), JSON.stringify(keys), JSON.stringify(options)], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      TERM: process.env.TERM === "dumb" ? "xterm-256color" : (process.env.TERM ?? "xterm-256color"),
    },
    timeout,
  });
}

function ptyDriverSource(): string {
  return String.raw`
import json
import os
import pty
import select
import signal
import sys
import time

repo_root = sys.argv[1]
project_root = sys.argv[2]
keys = json.loads(sys.argv[3])
options = json.loads(sys.argv[4]) if len(sys.argv) > 4 else {}
allow_terminate_after_keys = bool(options.get("allowTerminateAfterKeys"))

pid, master = pty.fork()
if pid == 0:
    os.chdir(project_root)
    os.execvpe(
        "bun",
        ["bun", "run", "src/main.ts", repo_root],
        {**os.environ, "TERM": os.environ.get("TERM") or "xterm-256color"},
    )

output = bytearray()
child_status = None

def poll_child():
    global child_status
    if child_status is not None:
        return child_status
    try:
        waited_pid, status = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        child_status = 0
        return child_status
    if waited_pid == pid:
        if os.WIFEXITED(status):
            child_status = os.WEXITSTATUS(status)
        elif os.WIFSIGNALED(status):
            child_status = 128 + os.WTERMSIG(status)
        else:
            child_status = 1
    return child_status

def drain(duration):
    deadline = time.time() + duration
    while time.time() < deadline:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(master, 4096)
            except OSError:
                return
            if not chunk:
                return
            output.extend(chunk)
        if poll_child() is not None:
            return

def state_ready(node_count):
    try:
        with open(os.path.join(repo_root, ".ccflow", "ccflow.json"), "r", encoding="utf-8") as handle:
            state = json.load(handle)
        nodes = list(state.get("nodes", {}).values())
        worktrees = list(state.get("worktrees", {}).values())
        if len(nodes) < int(node_count):
            return False
        if any(node.get("locked") for node in nodes):
            return False
        if any(worktree.get("locked") for worktree in worktrees):
            return False
        return True
    except Exception:
        return False

def wait_for_state(node_count, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        drain(0.1)
        if state_ready(node_count):
            return True
        if poll_child() is not None:
            return False
    return False

def file_ready(path, text=None):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            content = handle.read()
        return text is None or text in content
    except Exception:
        return False

def wait_for_file(path, text, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        drain(0.1)
        if file_ready(path, text):
            return True
        if poll_child() is not None:
            return False
    return False

def output_ready(text):
    return text in output.decode("utf-8", errors="ignore")

def wait_for_output(text, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        drain(0.1)
        if output_ready(text):
            return True
        if poll_child() is not None:
            return False
    return False

completed_keys = True
drain(0.8)
for item in keys:
    if item["sequence"]:
        os.write(master, item["sequence"].encode("utf-8"))
    if "injectSequence" in item:
        time.sleep(float(item.get("injectAfterMs", 0)) / 1000)
        os.write(master, item["injectSequence"].encode("utf-8"))
    if "waitForNodeCount" in item:
        if not wait_for_state(item["waitForNodeCount"], float(item["delay"])):
            completed_keys = False
            break
    elif "waitForFile" in item:
        if not wait_for_file(item["waitForFile"], None, float(item["delay"])):
            completed_keys = False
            break
    elif "waitForOutputText" in item:
        if not wait_for_output(item["waitForOutputText"], float(item["delay"])):
            completed_keys = False
            break
    elif "waitForFileText" in item:
        target = item["waitForFileText"]
        if not wait_for_file(target["path"], target["text"], float(item["delay"])):
            completed_keys = False
            break
    else:
        drain(float(item["delay"]))

deadline = time.time() + 8
while time.time() < deadline:
    drain(0.1)
    if poll_child() is not None:
        break

if poll_child() is None:
    os.kill(pid, signal.SIGTERM)
    deadline = time.time() + 2
    while time.time() < deadline and poll_child() is None:
        drain(0.05)
    if poll_child() is None:
        os.kill(pid, signal.SIGKILL)
        while poll_child() is None:
            drain(0.05)

sys.stdout.buffer.write(output)
if allow_terminate_after_keys and completed_keys:
    sys.exit(0)
sys.exit(child_status or 0)
`;
}
