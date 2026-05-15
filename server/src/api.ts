import express from "express";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { appendTranscript, contextPacket, newSummaryId, newTranscriptId, writeInitialTranscript, writeSummary } from "./context.js";
import { GitService } from "./git.js";
import { nodeWorktreePath } from "./paths.js";
import { Store } from "./storage.js";
import { TmuxRuntime } from "./tmux.js";
import type { AgentInvocation, FlowNode } from "./types.js";
import { run } from "./shell.js";

type Services = {
  store: Store;
  git: GitService;
  tmux: TmuxRuntime;
};

function requireProject(store: Store, projectId: string) {
  const project = store.getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  return project;
}

function requireNode(store: Store, nodeId: string) {
  const node = store.getNode(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

function asyncRoute(handler: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function invocationFor(node: FlowNode, cwd: string): AgentInvocation {
  if (node.contextFidelity === "live" && node.tmuxSession) {
    return { nodeId: node.id, cwd, runtime: "tmux-pty", resumeStrategy: "attach-live" };
  }
  if (node.contextFidelity === "exact-session" && node.claudeSessionId) {
    return { nodeId: node.id, cwd, runtime: "tmux-pty", resumeStrategy: "resume-session" };
  }
  if (node.contextFidelity === "clear") {
    return { nodeId: node.id, cwd, runtime: "tmux-pty", resumeStrategy: "new-clear" };
  }
  return { nodeId: node.id, cwd, runtime: "tmux-pty", resumeStrategy: "reconstruct" };
}

function nodeCwd(node: FlowNode, projectRepoPath: string) {
  return node.worktreePath ?? projectRepoPath;
}

export function createApp(services: Services) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post(
    "/api/projects/pick-folder",
    asyncRoute((_req, res) => {
      if (process.platform !== "darwin") {
        res.status(400).json({ error: "Native folder picker is currently implemented for macOS only." });
        return;
      }

      try {
        const selectedPath = run("osascript", [
          "-e",
          'set chosenFolder to choose folder with prompt "Choose a CCFlow project folder"',
          "-e",
          "POSIX path of chosenFolder"
        ]).replace(/\/$/, "");
        res.json({ repoPath: selectedPath });
      } catch {
        res.status(400).json({ error: "Folder selection cancelled." });
      }
    })
  );

  app.post(
    "/api/projects/open",
    asyncRoute((req, res) => {
      const requestedPath = String(req.body.repoPath ?? "").trim();
      if (!requestedPath) {
        res.status(400).json({ error: "Choose a project folder before opening a project." });
        return;
      }
      const repoPath = services.git.ensureRepo(path.resolve(requestedPath));
      const existing = services.store.getProjectByPath(repoPath);
      if (existing) {
        res.json({ project: existing, nodes: services.store.listNodes(existing.id) });
        return;
      }

      const nodeId = randomUUID();
      const commit = services.git.currentCommit(repoPath);
      const ref = services.git.createInternalRef(repoPath, nodeId, commit);
      const project = services.store.upsertProject({
        name: services.git.repoName(repoPath),
        repoPath,
        activeNodeId: nodeId
      });
      const transcriptId = newTranscriptId();
      const summaryId = newSummaryId();
      writeInitialTranscript(transcriptId, `Opened ${repoPath} at ${commit}\n`);
      writeSummary(summaryId, `Root context for ${project.name} at ${commit}.`);

      const root = services.store.createNode({
        id: nodeId,
        projectId: project.id,
        parentIds: [],
        kind: "turn",
        title: "Root",
        resultCommit: commit,
        snapshotRef: ref,
        transcriptId,
        contextSummaryId: summaryId,
        contextFidelity: "live",
        status: "idle",
        pinned: true
      });
      services.store.setActiveNode(project.id, root.id);

      res.json({ project, nodes: [root] });
    })
  );

  app.get(
    "/api/projects/:projectId/graph",
    asyncRoute((req, res) => {
      const project = requireProject(services.store, String(req.params.projectId));
      const nodes = services.store.listNodes(project.id);
      res.json({
        project,
        nodes,
        collapsedGroups: services.store.makeCollapsedGroups(nodes, project.activeNodeId)
      });
    })
  );

  app.post(
    "/api/nodes/:nodeId/run",
    asyncRoute((req, res) => {
      const node = requireNode(services.store, String(req.params.nodeId));
      const project = requireProject(services.store, node.projectId);
      const cwd = nodeCwd(node, project.repoPath);
      const invocation = invocationFor(node, cwd);
      const session = services.tmux.ensureSession(node, invocation);
      const next = services.store.updateNode(node.id, {
        tmuxSession: session,
        status: "running",
        contextFidelity: node.contextFidelity === "live" ? "live" : node.contextFidelity
      });
      services.store.setActiveNode(project.id, node.id);
      res.json({ node: next, invocation: { ...invocation, resumeStrategy: invocation.resumeStrategy } });
    })
  );

  app.post(
    "/api/nodes/:nodeId/child",
    asyncRoute((req, res) => {
      const parent = requireNode(services.store, String(req.params.nodeId));
      const project = requireProject(services.store, parent.projectId);
      const baseCommit = parent.resultCommit;
      const childId = randomUUID();
      const useLinearCwd = !parent.worktreePath;
      const worktreePath = useLinearCwd ? undefined : nodeWorktreePath(project.id, childId);

      if (worktreePath) {
        services.git.createWorktree({
          projectId: project.id,
          repoPath: project.repoPath,
          nodeId: childId,
          baseCommit,
          kind: "turn"
        });
      }

      const transcriptId = newTranscriptId();
      const summaryId = newSummaryId();
      writeInitialTranscript(transcriptId, `Child of ${parent.id}\n`);
      writeSummary(summaryId, `Continues context from ${parent.title}.`);
      const node = services.store.createNode({
        id: childId,
        projectId: project.id,
        parentIds: [parent.id],
        kind: "turn",
        title: String(req.body.title ?? "New turn"),
        resultCommit: baseCommit,
        snapshotRef: parent.snapshotRef,
        worktreePath,
        claudeSessionId: parent.claudeSessionId,
        transcriptId,
        contextSummaryId: summaryId,
        contextFidelity: parent.claudeSessionId ? "exact-session" : "reconstructed",
        status: "idle",
        pinned: false
      });
      services.store.setActiveNode(project.id, node.id);
      res.json({ node, contextPacket: node.contextFidelity === "reconstructed" ? contextPacket(parent) : undefined });
    })
  );

  app.post(
    "/api/nodes/:nodeId/clear",
    asyncRoute((req, res) => {
      const parent = requireNode(services.store, String(req.params.nodeId));
      const project = requireProject(services.store, parent.projectId);
      const clearId = randomUUID();
      const useNativeCwd = !parent.worktreePath;
      const worktree = useNativeCwd
        ? undefined
        : services.git.createWorktree({
            projectId: project.id,
            repoPath: project.repoPath,
            nodeId: clearId,
            baseCommit: parent.resultCommit,
            kind: "clear"
          }).worktreePath;

      const transcriptId = newTranscriptId();
      const summaryId = newSummaryId();
      writeInitialTranscript(transcriptId, `Clear context from ${parent.id}\n`);
      writeSummary(summaryId, `Clear node inheriting code snapshot ${parent.resultCommit}.`);
      const node = services.store.createNode({
        id: clearId,
        projectId: project.id,
        parentIds: [parent.id],
        kind: "clear",
        title: "Clear context",
        resultCommit: parent.resultCommit,
        snapshotRef: parent.snapshotRef,
        worktreePath: worktree,
        transcriptId,
        contextSummaryId: summaryId,
        contextFidelity: "clear",
        status: "idle",
        pinned: true
      });
      services.store.setActiveNode(project.id, node.id);
      res.json({ node });
    })
  );

  app.post(
    "/api/nodes/:nodeId/branch",
    asyncRoute((req, res) => {
      const parent = requireNode(services.store, String(req.params.nodeId));
      const project = requireProject(services.store, parent.projectId);
      const branchId = randomUUID();
      const { worktreePath } = services.git.createWorktree({
        projectId: project.id,
        repoPath: project.repoPath,
        nodeId: branchId,
        baseCommit: parent.resultCommit,
        kind: "branch"
      });
      const transcriptId = newTranscriptId();
      const summaryId = newSummaryId();
      writeInitialTranscript(transcriptId, `Branch from ${parent.id}\n`);
      writeSummary(summaryId, `Branch from ${parent.title}.`);
      const node = services.store.createNode({
        id: branchId,
        projectId: project.id,
        parentIds: [parent.id],
        kind: "branch",
        title: String(req.body.title ?? "Branch"),
        resultCommit: parent.resultCommit,
        snapshotRef: parent.snapshotRef,
        worktreePath,
        claudeSessionId: parent.claudeSessionId,
        transcriptId,
        contextSummaryId: summaryId,
        contextFidelity: parent.claudeSessionId ? "exact-session" : "reconstructed",
        status: "idle",
        pinned: true
      });
      services.store.setActiveNode(project.id, node.id);
      res.json({ node, contextPacket: node.contextFidelity === "reconstructed" ? contextPacket(parent) : undefined });
    })
  );

  app.post(
    "/api/nodes/:nodeId/rollback",
    asyncRoute((req, res) => {
      const target = requireNode(services.store, String(req.params.nodeId));
      const project = requireProject(services.store, target.projectId);
      const rollbackId = randomUUID();
      const { worktreePath } = services.git.createWorktree({
        projectId: project.id,
        repoPath: project.repoPath,
        nodeId: rollbackId,
        baseCommit: target.resultCommit,
        kind: "rollback"
      });
      const transcriptId = newTranscriptId();
      const summaryId = newSummaryId();
      writeInitialTranscript(transcriptId, `Rollback to ${target.id}\n`);
      writeSummary(summaryId, `Rollback node restored to ${target.title}.`);
      const node = services.store.createNode({
        id: rollbackId,
        projectId: project.id,
        parentIds: [target.id],
        kind: "rollback",
        title: `Rollback to ${target.title}`,
        resultCommit: target.resultCommit,
        snapshotRef: target.snapshotRef,
        worktreePath,
        claudeSessionId: target.claudeSessionId,
        transcriptId,
        contextSummaryId: summaryId,
        contextFidelity: target.claudeSessionId ? "exact-session" : "reconstructed",
        status: "idle",
        pinned: true
      });
      services.store.setActiveNode(project.id, node.id);
      res.json({ node, contextPacket: node.contextFidelity === "reconstructed" ? contextPacket(target) : undefined });
    })
  );

  app.post(
    "/api/projects/:projectId/merge",
    asyncRoute((req, res) => {
      const project = requireProject(services.store, String(req.params.projectId));
      const sourceIds = (req.body.sourceNodeIds ?? []) as string[];
      const sources = sourceIds.map((id) => requireNode(services.store, id));
      if (sources.length < 2) throw new Error("Merge requires at least two source nodes");

      const mergeId = randomUUID();
      const base = sources[0];
      const { worktreePath } = services.git.createWorktree({
        projectId: project.id,
        repoPath: project.repoPath,
        nodeId: mergeId,
        baseCommit: base.resultCommit,
        kind: "merge"
      });
      const mergeResult = services.git.mergeIntoWorktree({
        worktreePath,
        sourceCommits: sources.slice(1).map((node) => node.resultCommit)
      });
      const transcriptId = newTranscriptId();
      const summaryId = newSummaryId();
      writeInitialTranscript(transcriptId, `Merge ${sourceIds.join(", ")}\n`);
      writeSummary(summaryId, `Merge node for ${sources.map((node) => node.title).join(", ")}.`);
      const node = services.store.createNode({
        id: mergeId,
        projectId: project.id,
        parentIds: sourceIds,
        kind: "merge",
        title: "Merge",
        resultCommit: services.git.currentCommit(worktreePath),
        snapshotRef: `refs/ccflow/snapshots/${mergeId}`,
        worktreePath,
        transcriptId,
        contextSummaryId: summaryId,
        contextFidelity: "reconstructed",
        status: mergeResult.clean ? "done" : "conflict",
        pinned: true
      });
      if (mergeResult.clean) {
        const snapshot = services.git.snapshot(worktreePath, mergeId);
        services.store.updateNode(node.id, { resultCommit: snapshot.commit, snapshotRef: snapshot.ref });
      }
      services.store.setActiveNode(project.id, node.id);
      res.json({ node: services.store.getNode(node.id), mergeResult });
    })
  );

  app.post(
    "/api/nodes/:nodeId/snapshot",
    asyncRoute((req, res) => {
      const node = requireNode(services.store, String(req.params.nodeId));
      const project = requireProject(services.store, node.projectId);
      const cwd = nodeCwd(node, project.repoPath);
      const snapshot = services.git.snapshot(cwd, node.id);
      const next = services.store.updateNode(node.id, {
        resultCommit: snapshot.commit,
        snapshotRef: snapshot.ref,
        status: "done"
      });
      appendTranscript(node.transcriptId, `\nSnapshot ${snapshot.commit}\n`);
      res.json({ node: next });
    })
  );

  // ── CCFlow CLI Integration Endpoints ──────────────────

  app.post(
    "/api/projects/lookup",
    asyncRoute((req, res) => {
      const cwd = String(req.body.cwd ?? "").trim();
      if (!cwd) {
        res.status(400).json({ error: "cwd is required" });
        return;
      }
      const result = services.store.findProjectByCwd(cwd);
      if (!result) {
        res.json({ project: null, activeNode: null });
        return;
      }
      res.json({ project: result.project, activeNode: result.activeNode });
    })
  );

  app.post(
    "/api/nodes/:nodeId/cclear",
    asyncRoute((req, res) => {
      const parent = requireNode(services.store, String(req.params.nodeId));
      const project = requireProject(services.store, parent.projectId);
      const cwd = nodeCwd(parent, project.repoPath);

      const rawTitle = String(req.body.title ?? "Checkpoint");
      const nodeTitle = rawTitle.split("\n")[0].trim();
      const snapshot = services.git.snapshot(cwd, parent.id, rawTitle);
      services.store.updateNode(parent.id, {
        resultCommit: snapshot.commit,
        snapshotRef: snapshot.ref,
        status: "done"
      });

      const clearId = randomUUID();
      const useNativeCwd = !parent.worktreePath;
      const worktree = useNativeCwd
        ? undefined
        : services.git.createWorktree({
            projectId: project.id,
            repoPath: project.repoPath,
            nodeId: clearId,
            baseCommit: snapshot.commit,
            kind: "clear"
          }).worktreePath;

      const transcriptId = newTranscriptId();
      const summaryId = newSummaryId();
      writeInitialTranscript(transcriptId, `CClear checkpoint from ${parent.id}\n`);
      writeSummary(summaryId, `${nodeTitle} — snapshot ${snapshot.commit.slice(0, 7)}.`);

      const node = services.store.createNode({
        id: clearId,
        projectId: project.id,
        parentIds: [parent.id],
        kind: "clear",
        title: nodeTitle,
        resultCommit: snapshot.commit,
        snapshotRef: snapshot.ref,
        worktreePath: worktree,
        transcriptId,
        contextSummaryId: summaryId,
        contextFidelity: "clear",
        status: "running",
        pinned: false
      });
      services.store.setActiveNode(project.id, node.id);
      res.json({
        ok: true,
        node,
        commit: snapshot.commit
      });
    })
  );

  app.post(
    "/api/nodes/:nodeId/diverge",
    asyncRoute((req, res) => {
      const active = requireNode(services.store, String(req.params.nodeId));
      const project = requireProject(services.store, active.projectId);
      const cwd = nodeCwd(active, project.repoPath);

      const title = String(req.body.title ?? "Diverge");

      // 1. Snapshot current state
      const snapshot = services.git.snapshot(cwd, active.id, title);
      services.store.updateNode(active.id, {
        resultCommit: snapshot.commit,
        snapshotRef: snapshot.ref,
        status: "done"
      });

      // 2. Get parent — new node will be a SIBLING
      const parentId = active.parentIds[0];
      if (!parentId) {
        res.status(400).json({ error: "Cannot diverge from root node" });
        return;
      }
      const parent = requireNode(services.store, parentId);
      const baseCommit = parent.resultCommit;

      // 3. Create worktree from parent's commit
      const divergeId = randomUUID();
      const { worktreePath, branch: branchName } = services.git.createWorktree({
        projectId: project.id,
        repoPath: project.repoPath,
        nodeId: divergeId,
        baseCommit,
        kind: "branch"
      });

      // 4. Create sibling node (same parent as active)
      const transcriptId = newTranscriptId();
      const summaryId = newSummaryId();
      writeInitialTranscript(transcriptId, `Diverge from ${active.id} via parent ${parentId}\n`);
      writeSummary(summaryId, `Exploration branch: ${title} from ${parent.title}.`);

      const node = services.store.createNode({
        id: divergeId,
        projectId: project.id,
        parentIds: [parentId],
        kind: "branch",
        title,
        resultCommit: baseCommit,
        snapshotRef: parent.snapshotRef,
        worktreePath,
        transcriptId,
        contextSummaryId: summaryId,
        contextFidelity: "reconstructed",
        status: "running",
        pinned: true
      });
      services.store.setActiveNode(project.id, node.id);

      res.json({
        ok: true,
        node,
        worktreePath,
        branchName
      });
    })
  );

  // ── Error handler ─────────────────────────────────────

  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: error.message });
  });

  return app;
}

export function attachWebSocket(server: Server, services: Services) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    let detachTmux: (() => void) | undefined;
    const detachCurrentTmux = () => {
      detachTmux?.();
      detachTmux = undefined;
    };

    const sendError = (error: string) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "error", error }));
      }
    };

    const clearEndedSession = (node: FlowNode) => {
      if (!node.tmuxSession || services.tmux.hasSession(node.tmuxSession)) return false;
      services.store.updateNode(node.id, { tmuxSession: undefined, status: "idle" });
      detachCurrentTmux();
      sendError("Terminal session ended. Press Run / attach to start a new Claude PTY.");
      return true;
    };

    const onMessage = (raw: Buffer) => {
      try {
        const message = JSON.parse(raw.toString()) as
          | { type: "attach"; nodeId: string }
          | { type: "terminal-input"; nodeId: string; data: string }
          | { type: "terminal-resize"; nodeId: string; cols: number; rows: number }
          | { type: "ccflow-clear"; nodeId: string };

        if (message.type === "attach") {
          const node = requireNode(services.store, message.nodeId);
          if (!node.tmuxSession) {
            sendError("Node has no tmux session. Run the node first.");
            return;
          }
          if (clearEndedSession(node)) return;
          detachCurrentTmux();
          detachTmux = services.tmux.attach(ws, node.tmuxSession);
          ws.send(JSON.stringify({ type: "attached", nodeId: node.id, session: node.tmuxSession }));
          const snapshot = services.tmux.capture(node.tmuxSession);
          if (snapshot) {
            ws.send(JSON.stringify({ type: "terminal-snapshot", data: snapshot }));
          }
        }

        if (message.type === "terminal-input") {
          const node = requireNode(services.store, message.nodeId);
          if (!node.tmuxSession || clearEndedSession(node)) return;
          const result = services.tmux.sendRaw(node.tmuxSession, message.data);
          if (!result.ok) {
            if (!services.tmux.hasSession(node.tmuxSession)) {
              clearEndedSession(node);
              return;
            }
            sendError(result.stderr);
            return;
          }
          appendTranscript(node.transcriptId, message.data);
        }

        if (message.type === "terminal-resize") {
          const node = requireNode(services.store, message.nodeId);
          if (!node.tmuxSession || clearEndedSession(node)) return;
          const result = services.tmux.resize(node.tmuxSession, message.cols, message.rows);
          if (!result.ok) {
            if (!services.tmux.hasSession(node.tmuxSession)) {
              clearEndedSession(node);
              return;
            }
            sendError(result.stderr);
            return;
          }
          const snapshot = services.tmux.capture(node.tmuxSession);
          if (snapshot) ws.send(JSON.stringify({ type: "terminal-snapshot", data: snapshot }));
        }
      } catch (error) {
        sendError(error instanceof Error ? error.message : String(error));
      }
    };

    const onClose = () => {
      detachCurrentTmux();
      ws.removeListener("message", onMessage);
      ws.removeListener("close", onClose);
      ws.removeListener("error", onClose);
    };

    ws.on("message", onMessage);
    ws.on("close", onClose);
    ws.on("error", onClose);
  });

  return wss;
}
