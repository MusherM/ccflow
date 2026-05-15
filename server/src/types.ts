export type ContextFidelity = "live" | "exact-session" | "reconstructed" | "clear";

export type FlowNodeKind = "turn" | "branch" | "rollback" | "merge" | "clear";

export type FlowNodeStatus = "idle" | "running" | "done" | "failed" | "conflict";

export type AgentRuntime = "tmux-pty" | "headless-json";

export type ResumeStrategy =
  | "attach-live"
  | "resume-session"
  | "reconstruct"
  | "new-clear";

export type Project = {
  id: string;
  name: string;
  repoPath: string;
  activeNodeId: string;
  createdAt: string;
};

export type FlowNode = {
  id: string;
  projectId: string;
  parentIds: string[];
  kind: FlowNodeKind;
  title: string;
  resultCommit: string;
  snapshotRef: string;
  worktreePath?: string;
  tmuxSession?: string;
  claudeSessionId?: string;
  transcriptId: string;
  contextSummaryId?: string;
  contextFidelity: ContextFidelity;
  status: FlowNodeStatus;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AgentInvocation = {
  nodeId: string;
  cwd: string;
  runtime: AgentRuntime;
  resumeStrategy: ResumeStrategy;
};

export type GraphResponse = {
  project: Project;
  nodes: FlowNode[];
  collapsedGroups: CollapsedGroup[];
};

export type CollapsedGroup = {
  id: string;
  nodeIds: string[];
  label: string;
  summary: string;
};
