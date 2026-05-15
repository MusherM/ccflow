import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  CCFLOW_HOME,
  DB_PATH,
  PTY_LOG_ROOT,
  SUMMARY_ROOT,
  TRANSCRIPT_ROOT,
  WORKTREE_ROOT
} from "./paths.js";
import type { CollapsedGroup, FlowNode, FlowNodeKind, FlowNodeStatus, Project } from "./types.js";

type NodeRow = Omit<FlowNode, "parentIds" | "pinned"> & {
  parentIds: string;
  pinned: number;
};

export class Store {
  private db: DatabaseSync;

  constructor() {
    for (const dir of [CCFLOW_HOME, WORKTREE_ROOT, TRANSCRIPT_ROOT, SUMMARY_ROOT, PTY_LOG_ROOT]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(DB_PATH);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repoPath TEXT NOT NULL UNIQUE,
        activeNodeId TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        parentIds TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        resultCommit TEXT NOT NULL,
        snapshotRef TEXT NOT NULL,
        worktreePath TEXT,
        tmuxSession TEXT,
        claudeSessionId TEXT,
        transcriptId TEXT NOT NULL,
        contextSummaryId TEXT,
        contextFidelity TEXT NOT NULL,
        status TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(projectId) REFERENCES projects(id)
      );
    `);
  }

  upsertProject(input: { name: string; repoPath: string; activeNodeId: string }): Project {
    const existing = this.getProjectByPath(input.repoPath);
    if (existing) return existing;

    const project: Project = {
      id: randomUUID(),
      name: input.name,
      repoPath: input.repoPath,
      activeNodeId: input.activeNodeId,
      createdAt: new Date().toISOString()
    };

    this.db
      .prepare("INSERT INTO projects (id, name, repoPath, activeNodeId, createdAt) VALUES (?, ?, ?, ?, ?)")
      .run(project.id, project.name, project.repoPath, project.activeNodeId, project.createdAt);

    return project;
  }

  getProject(id: string): Project | undefined {
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project | undefined;
  }

  getProjectByPath(repoPath: string): Project | undefined {
    return this.db.prepare("SELECT * FROM projects WHERE repoPath = ?").get(repoPath) as Project | undefined;
  }

  findProjectByCwd(cwd: string): { project: Project; activeNode: FlowNode } | null {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY repoPath DESC").all() as any[];
    const cwdResolved = cwd.endsWith("/") ? cwd : cwd + "/";
    for (const row of rows) {
      const repoPrefix = (row.repoPath as string).endsWith("/") ? row.repoPath : row.repoPath + "/";
      if (cwdResolved.startsWith(repoPrefix)) {
        const project = row as Project;
        const activeNode = this.getNode(project.activeNodeId);
        return { project, activeNode: activeNode! };
      }
    }
    return null;
  }

  setActiveNode(projectId: string, nodeId: string) {
    this.db.prepare("UPDATE projects SET activeNodeId = ? WHERE id = ?").run(nodeId, projectId);
  }

  createNode(input: Omit<FlowNode, "id" | "createdAt" | "updatedAt"> & { id?: string }): FlowNode {
    const now = new Date().toISOString();
    const node: FlowNode = {
      id: input.id ?? randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...input
    };

    this.db
      .prepare(`
        INSERT INTO nodes (
          id, projectId, parentIds, kind, title, resultCommit, snapshotRef, worktreePath,
          tmuxSession, claudeSessionId, transcriptId, contextSummaryId, contextFidelity,
          status, pinned, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        node.id,
        node.projectId,
        JSON.stringify(node.parentIds),
        node.kind,
        node.title,
        node.resultCommit,
        node.snapshotRef,
        node.worktreePath ?? null,
        node.tmuxSession ?? null,
        node.claudeSessionId ?? null,
        node.transcriptId,
        node.contextSummaryId ?? null,
        node.contextFidelity,
        node.status,
        node.pinned ? 1 : 0,
        node.createdAt,
        node.updatedAt
      );

    return node;
  }

  updateNode(id: string, patch: Partial<FlowNode>): FlowNode {
    const current = this.getNode(id);
    if (!current) throw new Error(`Node not found: ${id}`);
    const next: FlowNode = { ...current, ...patch, id, updatedAt: new Date().toISOString() };

    this.db
      .prepare(`
        UPDATE nodes SET
          parentIds = ?, kind = ?, title = ?, resultCommit = ?, snapshotRef = ?,
          worktreePath = ?, tmuxSession = ?, claudeSessionId = ?, transcriptId = ?,
          contextSummaryId = ?, contextFidelity = ?, status = ?, pinned = ?, updatedAt = ?
        WHERE id = ?
      `)
      .run(
        JSON.stringify(next.parentIds),
        next.kind,
        next.title,
        next.resultCommit,
        next.snapshotRef,
        next.worktreePath ?? null,
        next.tmuxSession ?? null,
        next.claudeSessionId ?? null,
        next.transcriptId,
        next.contextSummaryId ?? null,
        next.contextFidelity,
        next.status,
        next.pinned ? 1 : 0,
        next.updatedAt,
        id
      );

    return next;
  }

  getNode(id: string): FlowNode | undefined {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
    return row ? this.mapNode(row) : undefined;
  }

  listNodes(projectId: string): FlowNode[] {
    const rows = this.db
      .prepare("SELECT * FROM nodes WHERE projectId = ? ORDER BY createdAt ASC")
      .all(projectId) as NodeRow[];
    return rows.map((row) => this.mapNode(row));
  }

  listChildren(nodeId: string): FlowNode[] {
    const rows = this.db.prepare("SELECT * FROM nodes ORDER BY createdAt ASC").all() as NodeRow[];
    return rows.map((row) => this.mapNode(row)).filter((node) => node.parentIds.includes(nodeId));
  }

  makeCollapsedGroups(nodes: FlowNode[], activeNodeId: string): CollapsedGroup[] {
    const activePath = new Set<string>();
    let cursor = nodes.find((node) => node.id === activeNodeId);
    while (cursor) {
      activePath.add(cursor.id);
      cursor = nodes.find((node) => node.id === cursor?.parentIds[0]);
    }

    const ordinaryPath = nodes
      .filter((node) => activePath.has(node.id))
      .filter((node) => node.kind === "turn" && !node.pinned && node.status === "done");

    if (ordinaryPath.length <= 20) return [];
    const foldable = ordinaryPath.slice(0, ordinaryPath.length - 20);

    return [
      {
        id: `group-${foldable[0]?.id}-${foldable.at(-1)?.id}`,
        nodeIds: foldable.map((node) => node.id),
        label: `${foldable.length} folded turns`,
        summary: `Older linear context from ${foldable[0]?.title} to ${foldable.at(-1)?.title}.`
      }
    ];
  }

  private mapNode(row: NodeRow): FlowNode {
    return {
      ...row,
      parentIds: JSON.parse(row.parentIds) as string[],
      pinned: row.pinned === 1,
      worktreePath: row.worktreePath ?? undefined,
      tmuxSession: row.tmuxSession ?? undefined,
      claudeSessionId: row.claudeSessionId ?? undefined,
      contextSummaryId: row.contextSummaryId ?? undefined,
      kind: row.kind as FlowNodeKind,
      status: row.status as FlowNodeStatus
    };
  }
}
