import fs from "node:fs";
import path from "node:path";
import type { CcflowNode, CcflowState, JobRecord, PromptsConfig } from "./types.js";
import { assertGraphInvariants, createInitialState } from "./graph.js";
import { defaultPrompts } from "./prompts.js";

export function ccflowDir(repoRoot: string): string {
  return path.join(repoRoot, ".ccflow");
}

export function statePath(repoRoot: string): string {
  return path.join(ccflowDir(repoRoot), "ccflow.json");
}

export function promptsPath(repoRoot: string): string {
  return path.join(ccflowDir(repoRoot), "prompts.json");
}

export function sessionsDir(repoRoot: string): string {
  return path.join(ccflowDir(repoRoot), "sessions");
}

export function jobsDir(repoRoot: string): string {
  return path.join(ccflowDir(repoRoot), "jobs");
}

export function logsDir(repoRoot: string): string {
  return path.join(ccflowDir(repoRoot), "logs");
}

export function ensureCcflowDirs(repoRoot: string): void {
  for (const dir of [ccflowDir(repoRoot), sessionsDir(repoRoot), jobsDir(repoRoot), logsDir(repoRoot)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadOrInitState(input: {
  repoRoot: string;
  branch: string;
  commitHash: string | null;
}): CcflowState {
  ensureCcflowDirs(input.repoRoot);

  const file = statePath(input.repoRoot);
  if (fs.existsSync(file)) {
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as CcflowState;
    assertGraphInvariants(state);
    return state;
  }

  const state = createInitialState(input);
  saveState(state);
  return state;
}

export function saveState(state: CcflowState): void {
  assertGraphInvariants(state);
  ensureCcflowDirs(state.repoRoot);
  writeJsonAtomic(statePath(state.repoRoot), state);
}

export function loadPrompts(repoRoot: string): PromptsConfig {
  const file = promptsPath(repoRoot);
  if (!fs.existsSync(file)) return defaultPrompts;
  return JSON.parse(fs.readFileSync(file, "utf8")) as PromptsConfig;
}

export function ensurePrompts(repoRoot: string): void {
  ensureCcflowDirs(repoRoot);
  const file = promptsPath(repoRoot);
  if (!fs.existsSync(file)) {
    writeJsonAtomic(file, defaultPrompts);
  }
}

export function saveSession(repoRoot: string, node: CcflowNode): void {
  ensureCcflowDirs(repoRoot);
  writeJsonAtomic(path.join(sessionsDir(repoRoot), `${node.id}.json`), {
    nodeId: node.id,
    cc: node.cc,
    updatedAt: node.updatedAt,
  });
}

export function saveJob(repoRoot: string, job: JobRecord): void {
  ensureCcflowDirs(repoRoot);
  writeJsonAtomic(path.join(jobsDir(repoRoot), `${job.jobId}.json`), job);
}

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}
