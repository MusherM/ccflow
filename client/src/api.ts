import type { FlowNode, GraphResponse, Project } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Request failed");
  return body as T;
}

export const api = {
  pickProjectFolder() {
    return request<{ repoPath: string }>("/api/projects/pick-folder", { method: "POST" });
  },
  openProject(repoPath: string) {
    return request<{ project: Project; nodes: FlowNode[] }>("/api/projects/open", {
      method: "POST",
      body: JSON.stringify({ repoPath })
    });
  },
  graph(projectId: string) {
    return request<GraphResponse>(`/api/projects/${projectId}/graph`);
  },
  runNode(nodeId: string) {
    return request<{ node: FlowNode }>(`/api/nodes/${nodeId}/run`, { method: "POST" });
  },
  createChild(nodeId: string) {
    return request<{ node: FlowNode; contextPacket?: string }>(`/api/nodes/${nodeId}/child`, {
      method: "POST",
      body: JSON.stringify({ title: "Turn" })
    });
  },
  clearNode(nodeId: string) {
    return request<{ node: FlowNode }>(`/api/nodes/${nodeId}/clear`, { method: "POST" });
  },
  branchNode(nodeId: string) {
    return request<{ node: FlowNode; contextPacket?: string }>(`/api/nodes/${nodeId}/branch`, {
      method: "POST",
      body: JSON.stringify({ title: "Branch" })
    });
  },
  rollbackNode(nodeId: string) {
    return request<{ node: FlowNode; contextPacket?: string }>(`/api/nodes/${nodeId}/rollback`, {
      method: "POST"
    });
  },
  merge(projectId: string, sourceNodeIds: string[]) {
    return request<{ node: FlowNode }>(`/api/projects/${projectId}/merge`, {
      method: "POST",
      body: JSON.stringify({ sourceNodeIds })
    });
  },
  snapshot(nodeId: string) {
    return request<{ node: FlowNode }>(`/api/nodes/${nodeId}/snapshot`, { method: "POST" });
  }
};
