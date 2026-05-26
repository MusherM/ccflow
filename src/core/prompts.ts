import type { CcflowNode } from "./types.js";
import type { CcflowConfig, LoadedConfig } from "./config.js";

export interface LegacyPromptCommandConfig {
  diff?: string;
  status?: string;
  commit?: string;
  merge?: string;
  test?: string;
}

export interface LegacyPromptEntry {
  system: string;
  prompt: string;
  strategy?: string;
  commands: LegacyPromptCommandConfig;
}

export interface LegacyPromptsConfig {
  commit: LegacyPromptEntry;
  merge: LegacyPromptEntry;
}

export const defaultPrompts: LegacyPromptsConfig = {
  commit: {
    system: "You are an expert software engineer using Claude Code.",
    prompt: "",
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

export interface CommitPromptInput {
  config: CcflowConfig;
  node: CcflowNode;
  gitStatus: string;
  gitDiff: string;
}

export interface MergePromptInput {
  config: CcflowConfig;
  worktreePath: string;
  conflictFiles: string[];
  gitStatus: string;
}

export function buildCommitPrompt(input: CommitPromptInput): string {
  const sections = [
    "# CCFlow Commit Job Kernel",
    "You are an expert software engineer using Claude Code.",
    "Review the worktree below. You MUST leave it in a clean committed state, or clean with nothing to commit.",
    "",
    "Non-overridable workflow contract:",
    "- Look at every untracked file before staging.",
    "- Add patterns for non-project files such as build output, downloads, logs, personal files, or local tool state to .gitignore.",
    "- Stage project changes with git add . after non-project files are ignored.",
    "- If staged changes exist, create a git commit with an appropriate message.",
    "- If nothing is staged after git add ., stop without creating an empty commit.",
    "- Do not ask questions. Follow the steps in order.",
    "",
    "Node:",
    JSON.stringify({ id: input.node.id, title: input.node.title, branch: input.node.git.branch }, null, 2),
    "",
    "Git status:",
    input.gitStatus || "(clean)",
    "",
    "Git diff:",
    input.gitDiff || "(no diff)",
  ];

  const custom = customCommitSections(input.config);
  if (custom.length > 0) sections.push("", "# Additive User And Project Guidance", ...custom);
  return sections.join("\n");
}

export function buildMergePrompt(input: MergePromptInput): string {
  const sections = [
    "# CCFlow Merge Job Kernel",
    "You are an expert software engineer responsible for merging multiple branches safely.",
    "",
    "Non-overridable workflow contract:",
    "- Resolve all merge conflicts when possible.",
    "- Preserve the intent of every input branch.",
    "- Create a merge commit when all conflicts are resolved.",
    "- If you cannot resolve every conflict, leave the remaining conflicts in the worktree for interactive resolution.",
    "- Do not ask questions during this headless job.",
    "",
    "Merge worktree:",
    input.worktreePath,
    "",
    "Conflict files:",
    input.conflictFiles.length > 0 ? input.conflictFiles.join("\n") : "(none)",
    "",
    "Git status:",
    input.gitStatus || "(clean)",
  ];

  const custom = customMergeSections(input.config);
  if (custom.length > 0) sections.push("", "# Additive User And Project Guidance", ...custom);
  return sections.join("\n");
}

export function renderPromptInspection(kind: "commit" | "merge", loaded: LoadedConfig): string {
  const sourceLines = Object.entries(loaded.sources)
    .filter(([field]) => field.startsWith(`prompts.${kind}.`))
    .map(([field, source]) => `- ${field}: ${source.path ? `${source.label} (${source.path})` : source.label}`);
  const prompt = kind === "commit"
    ? buildCommitPrompt({
      config: loaded.config,
      node: {
        id: "node_preview",
        title: "Preview node",
        type: "leaf",
        parents: [],
        children: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        git: { commitHash: "preview", branch: "main", worktreeId: "wt_main" },
        cc: { sessionId: null, processId: null, resumeMode: "new" },
        stats: { filesChanged: 0, insertions: 0, deletions: 0, symbolsChanged: [] },
        status: "LeafNew",
      },
      gitStatus: " M example.ts",
      gitDiff: "(diff omitted in prompt preview)",
    })
    : buildMergePrompt({
      config: loaded.config,
      worktreePath: "/repo/.worktrees/ccflow-merge-preview",
      conflictFiles: ["example.ts"],
      gitStatus: "UU example.ts",
    });
  return [
    `# Effective ${kind} prompt`,
    "",
    "## Source attribution",
    sourceLines.length > 0 ? sourceLines.join("\n") : "- prompt customization: built-in defaults only",
    "",
    "## Prompt",
    prompt,
  ].join("\n");
}

function customCommitSections(config: CcflowConfig): string[] {
  const sections: string[] = [];
  if (config.prompts.commit.instructions.length > 0) {
    sections.push("Commit instructions:", ...config.prompts.commit.instructions.map((item) => `- ${item}`), "");
  }
  if (config.prompts.commit.messageStyle) {
    sections.push(`Commit message style: ${config.prompts.commit.messageStyle}`, "");
  }
  if (config.prompts.commit.testPreferences.length > 0) {
    sections.push("Test/check preferences:", ...config.prompts.commit.testPreferences.map((item) => `- ${item}`), "");
  }
  if (config.tests.commands.length > 0) {
    sections.push("Known project check commands:", ...config.tests.commands.map((item) => `- ${item}`), "");
  }
  return trimTrailingBlank(sections);
}

function customMergeSections(config: CcflowConfig): string[] {
  const sections: string[] = [];
  if (config.prompts.merge.instructions.length > 0) {
    sections.push("Merge instructions:", ...config.prompts.merge.instructions.map((item) => `- ${item}`), "");
  }
  if (config.prompts.merge.testPreferences.length > 0) {
    sections.push("Test/check preferences:", ...config.prompts.merge.testPreferences.map((item) => `- ${item}`), "");
  }
  if (config.tests.commands.length > 0) {
    sections.push("Known project check commands:", ...config.tests.commands.map((item) => `- ${item}`), "");
  }
  return trimTrailingBlank(sections);
}

function trimTrailingBlank(lines: string[]): string[] {
  while (lines.at(-1) === "") lines.pop();
  return lines;
}
