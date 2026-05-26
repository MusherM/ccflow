import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ClaudeAdapter } from "./core/claude.js";
import { GitAdapter } from "./core/git.js";
import { getNode, getWorktree, isLeafNode, switchCurrentWorktree } from "./core/graph.js";
import { JobRunner } from "./core/jobs.js";
import { saveSession, saveState } from "./core/storage.js";
import type { CcflowConfig } from "./core/config.js";
import type { CcflowNode, CcflowState } from "./core/types.js";

export async function runBasicTui(
  state: CcflowState,
  options: { config: CcflowConfig; reason?: string },
): Promise<void> {
  const rl = readline.createInterface({ input, output });
  const git = new GitAdapter();
  const claude = new ClaudeAdapter();
  const jobs = new JobRunner(git, claude);
  output.write("CCFlow basic TUI\n");
  if (options.reason) {
    output.write(`OpenTUI is unavailable, using basic Node interface: ${options.reason}\n`);
  }

  try {
    while (true) {
      const node = getNode(state, state.currentNodeId);
      renderState(state, node);
      const answer = (await rl.question("[enter] open Claude, [tab] next, [d] delete leaf, [q] quit > ")).trim().toLowerCase();
      if (answer === "q" || answer === "quit") return;
      if (answer === "" || answer === "enter") {
        await enterNode(state, node, claude, options.config);
      } else if (answer === "tab" || answer === "t") {
        const child = await jobs.createNextNode(state, node.id);
        state.currentNodeId = child.id;
        saveState(state);
      } else if (answer === "d" || answer === "delete") {
        const focus = await jobs.deleteLeaf(state, node.id);
        state.currentNodeId = focus.id;
        saveState(state);
      } else {
        output.write(`Unknown command: ${answer}\n`);
      }
    }
  } finally {
    rl.close();
  }
}

function renderState(state: CcflowState, node: CcflowNode): void {
  const worktree = getWorktree(state, node.git.worktreeId);
  output.write([
    "",
    `Node: ${node.id} (${node.status})`,
    `Title: ${node.title}`,
    `Branch: ${node.git.branch}`,
    `Worktree: ${worktree.path}`,
    `Commit: ${node.git.commitHash ?? "(none)"}`,
    `Leaves: ${Object.values(state.nodes).filter((candidate) => isLeafNode(state, candidate.id)).length}`,
    "",
  ].join("\n"));
}

async function enterNode(state: CcflowState, node: CcflowNode, claude: ClaudeAdapter, config: CcflowConfig): Promise<void> {
  const worktree = getWorktree(state, node.git.worktreeId);
  if (state.settings.worktree.enterLeafAutoSwitch) switchCurrentWorktree(state, node.id);
  node.status = "LeafRunning";
  node.cc.resumeMode = node.cc.sessionId ? "resume" : "new";
  saveState(state);
  const result = await claude.attachOrResume(node, worktree.path, state.repoRoot, config);
  node.cc.sessionId = result.sessionId;
  node.cc.processId = null;
  node.cc.resumeMode = result.sessionId ? "resume" : "new";
  node.status = result.sessionId ? "LeafResumable" : "LeafNew";
  saveSession(state.repoRoot, node);
  saveState(state);
}
