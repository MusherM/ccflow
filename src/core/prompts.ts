import type { PromptsConfig } from "./types.js";

export const defaultPrompts: PromptsConfig = {
  commit: {
    system: "You are an expert software engineer using Claude Code.",
    prompt:
      "Review the current git diff, summarize the work, run necessary checks if possible, then create a clean git commit. The commit message should be concise and follow conventional commits when appropriate.",
    commands: {
      diff: "git diff",
      status: "git status --short",
      commit: "git commit",
    },
  },
  merge: {
    system: "You are an expert software engineer responsible for merging multiple branches safely.",
    prompt:
      "Merge the selected leaf nodes. Resolve conflicts carefully, preserve both branches' intent, run tests if available, and create a final merge commit with a clear summary.",
    strategy: "claude-assisted",
    commands: {
      status: "git status --short",
      merge: "git merge",
      test: "auto",
    },
  },
};
