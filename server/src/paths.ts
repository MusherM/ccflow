import os from "node:os";
import path from "node:path";

export const CCFLOW_HOME = process.env.CCFLOW_HOME ?? path.join(os.homedir(), ".ccflow");
export const DB_PATH = path.join(CCFLOW_HOME, "ccflow.sqlite");
export const WORKTREE_ROOT = path.join(CCFLOW_HOME, "worktrees");
export const TRANSCRIPT_ROOT = path.join(CCFLOW_HOME, "transcripts");
export const SUMMARY_ROOT = path.join(CCFLOW_HOME, "summaries");
export const PTY_LOG_ROOT = path.join(CCFLOW_HOME, "pty-logs");

export function projectWorktreeRoot(projectId: string) {
  return path.join(WORKTREE_ROOT, projectId);
}

export function nodeWorktreePath(projectId: string, nodeId: string) {
  return path.join(projectWorktreeRoot(projectId), nodeId);
}

export function transcriptPath(transcriptId: string) {
  return path.join(TRANSCRIPT_ROOT, `${transcriptId}.log`);
}

export function summaryPath(summaryId: string) {
  return path.join(SUMMARY_ROOT, `${summaryId}.md`);
}

export function ptyLogPath(nodeId: string) {
  return path.join(PTY_LOG_ROOT, `${nodeId}.log`);
}
