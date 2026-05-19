import path from "node:path";
import { GitAdapter } from "./core/git.js";
import { normalizeAfterBoot } from "./core/graph.js";
import { loadOrInitState, saveState } from "./core/storage.js";
import { runCcflowTui } from "./tui.js";

async function main(): Promise<void> {
  const cwd = path.resolve(process.argv[2] ?? process.cwd());
  const git = new GitAdapter();
  const repoRoot = git.ensureRepo(cwd);
  const state = loadOrInitState({
    repoRoot,
    branch: git.currentBranch(repoRoot),
    commitHash: git.currentCommit(repoRoot),
  });
  normalizeAfterBoot(state);
  saveState(state);

  await runCcflowTui(state);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
