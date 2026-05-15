import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  useEdgesState,
  useNodesState
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@xterm/xterm/css/xterm.css";
import { api } from "./api";
import { TerminalPane } from "./components/TerminalPane";
import type { FlowNode, GraphResponse, Project } from "./types";
import "./styles.css";

function App() {
  const [repoPath, setRepoPath] = useState("");
  const [project, setProject] = useState<Project | null>(null);
  const [flowNodes, setFlowNodes] = useState<FlowNode[]>([]);
  const [activeNode, setActiveNode] = useState<FlowNode | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [contextPacket, setContextPacket] = useState<string | null>(null);

  const refresh = useCallback(async (projectId = project?.id) => {
    if (!projectId) return;
    const graph = await api.graph(projectId);
    applyGraph(graph);
  }, [project?.id]);

  const handleClear = useCallback(async (nodeId: string) => {
    const result = await api.clearNode(nodeId);
    await refresh(result.node.projectId);
    const run = await api.runNode(result.node.id);
    setActiveNode(run.node);
  }, [refresh]);

  function applyGraph(graph: GraphResponse) {
    setProject(graph.project);
    setFlowNodes(graph.nodes);
    setActiveNode((current) => graph.nodes.find((node) => node.id === current?.id) ?? graph.nodes.find((node) => node.id === graph.project.activeNodeId) ?? graph.nodes[0] ?? null);
  }

  async function perform(action: () => Promise<void>) {
    try {
      setError(null);
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function openProjectPath(path: string) {
    const opened = await api.openProject(path);
    setRepoPath(opened.project.repoPath);
    applyGraph({ ...opened, collapsedGroups: [] });
  }

  const graph = useMemo(() => makeGraph(flowNodes), [flowNodes]);
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);

  useEffect(() => {
    setNodes((current) => areNodesEqual(current, graph.nodes) ? current : graph.nodes);
    setEdges((current) => areEdgesEqual(current, graph.edges) ? current : graph.edges);
  }, [graph, setEdges, setNodes]);

  const handleSelectionChange = useCallback(({ nodes }: { nodes: Node[] }) => {
    const nextIds = nodes.map((node) => node.id);
    setSelectedIds((current) => areStringArraysEqual(current, nextIds) ? current : nextIds);
  }, []);

  return (
    <div className="shell">
      <div className="crt-overlay" aria-hidden="true" />
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src="/ccflow-logo.png" alt="CCFlow logo" />
          <div>
            <h1>CCFlow</h1>
            <p>AI worktree switchboard</p>
          </div>
        </div>

        <div className="signal-card">
          <span className="scanline-label">SYSTEM BUS</span>
          <div className="meter">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
          <code>tmux / git / claude</code>
        </div>

        <label className="field">
          <span>Repository root</span>
          <input value={repoPath} onChange={(event) => setRepoPath(event.target.value)} placeholder="/path/to/git/repo" />
        </label>
        <div className="project-actions">
          <button className="primary" onClick={() => perform(async () => {
            const picked = await api.pickProjectFolder();
            await openProjectPath(picked.repoPath);
          })}>
            Open project
          </button>
          <button disabled={!repoPath.trim()} onClick={() => perform(async () => openProjectPath(repoPath))}>
            Use typed path
          </button>
        </div>

        {project && (
          <div className="project-card">
            <span>Project</span>
            <strong>{project.name}</strong>
            <small>{project.repoPath}</small>
            <div className="project-stats">
              <b>{flowNodes.length}</b>
              <em>nodes</em>
              <b>{selectedIds.length}</b>
              <em>selected</em>
            </div>
          </div>
        )}

        <div className="legend">
          <span className="dot turn" /> turn
          <span className="dot branch" /> branch
          <span className="dot rollback" /> rollback
          <span className="dot clear" /> clear
          <span className="dot merge" /> merge
        </div>

        <pre className="ascii-map" aria-hidden="true">{String.raw`
       [turn]
          |
   +------+------+
   |             |
[branch]      [clear]
   |             |
   +----[merge]--+`}</pre>
      </aside>

      <main className="canvas">
        <div className="toolbar">
          <button disabled={!activeNode} onClick={() => activeNode && perform(async () => setActiveNode((await api.runNode(activeNode.id)).node))}>
            Run / attach
          </button>
          <button disabled={!activeNode} onClick={() => activeNode && perform(async () => {
            const created = await api.createChild(activeNode.id);
            setContextPacket(created.contextPacket ?? null);
            await refresh(created.node.projectId);
          })}>
            Continue child
          </button>
          <button disabled={!activeNode} onClick={() => activeNode && perform(async () => {
            const created = await api.branchNode(activeNode.id);
            setContextPacket(created.contextPacket ?? null);
            await refresh(created.node.projectId);
          })}>
            Branch
          </button>
          <button disabled={!activeNode} onClick={() => activeNode && perform(async () => {
            const created = await api.rollbackNode(activeNode.id);
            setContextPacket(created.contextPacket ?? null);
            await refresh(created.node.projectId);
          })}>
            Rollback
          </button>
          <button disabled={!activeNode} onClick={() => activeNode && perform(async () => {
            const created = await api.clearNode(activeNode.id);
            await refresh(created.node.projectId);
            setActiveNode(created.node);
          })}>
            Clear node
          </button>
          <button disabled={!project || selectedIds.length < 2} onClick={() => project && perform(async () => {
            const created = await api.merge(project.id, selectedIds);
            await refresh(created.node.projectId);
          })}>
            Merge selected
          </button>
          <button disabled={!activeNode} onClick={() => activeNode && perform(async () => {
            const snap = await api.snapshot(activeNode.id);
            await refresh(snap.node.projectId);
          })}>
            Snapshot
          </button>
        </div>

        <div className="canvas-badge" aria-hidden="true">
          <span>NODE MATRIX</span>
          <code>{activeNode?.id.slice(0, 8) ?? "standby"}</code>
        </div>

        {error && <div className="error">{error}</div>}

        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          onNodeClick={(_, node) => {
            const flowNode = flowNodes.find((item) => item.id === node.id);
            if (flowNode) setActiveNode(flowNode);
          }}
          onSelectionChange={handleSelectionChange}
        >
          <Background color="#4a3a1d" gap={18} />
          <MiniMap pannable zoomable />
          <Controls />
        </ReactFlow>
      </main>

      <section className="composer">
        <div className="context-panel">
          <span className="eyebrow">Recovered Context</span>
          <h2>{activeNode?.title ?? "No node selected"}</h2>
          <div className="context-tape">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          {activeNode ? (
            <dl>
              <dt>Fidelity</dt>
              <dd className={`pill ${activeNode.contextFidelity}`}>{activeNode.contextFidelity}</dd>
              <dt>Kind</dt>
              <dd>{activeNode.kind}</dd>
              <dt>Status</dt>
              <dd>{activeNode.status}</dd>
              <dt>Commit</dt>
              <dd>{activeNode.resultCommit.slice(0, 12)}</dd>
              <dt>Worktree</dt>
              <dd>{activeNode.worktreePath ?? "native repo cwd"}</dd>
              <dt>Session</dt>
              <dd>{activeNode.tmuxSession ?? "not attached"}</dd>
            </dl>
          ) : (
            <p>Open a git repository to begin.</p>
          )}
          {contextPacket && <pre className="packet">{contextPacket}</pre>}
        </div>
        <TerminalPane node={activeNode} title="CLAUDE CODE PTY" onClear={handleClear} />
      </section>
    </div>
  );
}

const nodeGlyphs: Record<FlowNode["kind"], string> = {
  turn: ">>",
  branch: "Y",
  rollback: "<<",
  merge: "><",
  clear: "00"
};

function FlowNodeComponent({ data }: { data: FlowNode }) {
  return (
    <div className={`flow-node ${data.kind} ${data.status}`}>
      <i>{nodeGlyphs[data.kind]}</i>
      <strong>{data.title}</strong>
      <span>{data.contextFidelity}</span>
      <small>{data.resultCommit.slice(0, 7)}</small>
    </div>
  );
}

const nodeTypes = { flowNode: FlowNodeComponent };

function makeGraph(flowNodes: FlowNode[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = flowNodes.map((node, index) => ({
    id: node.id,
    type: "flowNode",
    position: { x: (index % 4) * 260, y: Math.floor(index / 4) * 160 },
    data: node,
    className: `react-node ${node.kind}`
  }));

  const edges: Edge[] = flowNodes.flatMap((node) =>
    node.parentIds.map((parentId) => ({
      id: `${parentId}-${node.id}`,
      source: parentId,
      target: node.id,
      animated: node.status === "running"
    }))
  );

  return { nodes, edges };
}

function areStringArraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function areNodesEqual(left: Node[], right: Node[]) {
  return left.length === right.length && left.every((node, index) => {
    const next = right[index];
    return next
      && node.id === next.id
      && node.type === next.type
      && node.className === next.className
      && node.position.x === next.position.x
      && node.position.y === next.position.y
      && node.data === next.data;
  });
}

function areEdgesEqual(left: Edge[], right: Edge[]) {
  return left.length === right.length && left.every((edge, index) => {
    const next = right[index];
    return next
      && edge.id === next.id
      && edge.source === next.source
      && edge.target === next.target
      && edge.animated === next.animated;
  });
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
