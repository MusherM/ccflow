import test from "node:test";
import assert from "node:assert/strict";
import { defaultCcflowConfig } from "../src/core/config.js";
import { buildCommitPrompt, buildMergePrompt, renderPromptInspection } from "../src/core/prompts.js";

test("commit prompt keeps kernel instructions and includes additive customization", () => {
  const config = defaultCcflowConfig();
  config.prompts.commit.instructions = ["Prefer small commits."];
  config.prompts.commit.messageStyle = "imperative subject";
  const prompt = buildCommitPrompt({
    config,
    node: {
      id: "node_test",
      title: "Test",
      type: "leaf",
      parents: [],
      children: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      git: { branch: "main", commitHash: "abc", worktreeId: "wt_main" },
      cc: { sessionId: null, processId: null, resumeMode: "new" },
      stats: { filesChanged: 0, insertions: 0, deletions: 0, symbolsChanged: [] },
      status: "LeafNew",
    },
    gitStatus: " M file.ts",
    gitDiff: "diff --git a/file.ts b/file.ts",
  });

  assert.match(prompt, /MUST leave it in a clean committed state/);
  assert.match(prompt, /Do not ask questions/);
  assert.match(prompt, /Prefer small commits/);
  assert.match(prompt, /imperative subject/);
});

test("merge prompt keeps conflict resolution kernel and includes customization", () => {
  const config = defaultCcflowConfig();
  config.prompts.merge.instructions = ["Keep both APIs compatible."];
  const prompt = buildMergePrompt({
    config,
    worktreePath: "/repo/.worktrees/merge",
    conflictFiles: ["src/a.ts"],
    gitStatus: "UU src/a.ts",
  });

  assert.match(prompt, /Resolve all merge conflicts/);
  assert.match(prompt, /leave the remaining conflicts/);
  assert.match(prompt, /src\/a\.ts/);
  assert.match(prompt, /Keep both APIs compatible/);
});

test("prompt inspection renders without launching Claude", () => {
  const config = defaultCcflowConfig();
  config.prompts.commit.instructions = ["Preview instruction."];
  const rendered = renderPromptInspection("commit", {
    config,
    paths: { userGlobalPath: "/home/user/.ccflowrc", xdgGlobalPath: "/home/user/.config/ccflow/config.json" },
    files: [],
    sources: {
      "prompts.commit.instructions": { kind: "user-global", label: "user global config", path: "/home/user/.ccflowrc" },
    },
  });
  assert.match(rendered, /Effective commit prompt/);
  assert.match(rendered, /Source attribution/);
  assert.match(rendered, /Preview instruction/);
});
