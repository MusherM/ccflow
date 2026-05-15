"""Data model for the CCFlow conversation graph."""

from __future__ import annotations

from dataclasses import dataclass, field

BRANCH_COLORS: list[str] = [
    "#d24b2a",
    "#217c68",
    "#b98b17",
    "#5b7fbd",
    "#8b5ba0",
    "#c45b24",
]

BRANCH_NAMES = [
    "main",
    "oauth-explore",
    "sso-explore",
    "refactor-auth",
    "api-v2",
    "db-migration",
]


@dataclass
class GraphNode:
    id: str
    summary: str
    branch: str = "main"
    files: list[str] = field(default_factory=list)
    status: str = "active"
    tags: list[str] = field(default_factory=list)
    detail_lines: list[str] = field(default_factory=list)


@dataclass
class ConversationGraph:
    nodes: dict[str, GraphNode] = field(default_factory=dict)
    edges: dict[str, list[str]] = field(default_factory=dict)
    merge_sources: dict[str, list[str]] = field(default_factory=dict)
    root_id: str = ""
    current_id: str = ""

    def children_of(self, node_id: str) -> list[str]:
        return self.edges.get(node_id, [])

    def parent_of(self, node_id: str) -> str | None:
        for pid, children in self.edges.items():
            if node_id in children:
                return pid
        return None

    def branch_color(self, branch: str) -> str:
        if branch not in BRANCH_NAMES:
            idx = hash(branch) % len(BRANCH_COLORS)
        else:
            idx = BRANCH_NAMES.index(branch) % len(BRANCH_COLORS)
        return BRANCH_COLORS[idx]

    def all_branches(self) -> list[str]:
        seen: list[str] = []
        for n in self.nodes.values():
            if n.branch not in seen:
                seen.append(n.branch)
        return seen

    def update_branch_names(self) -> None:
        """Sync BRANCH_NAMES from graph data so color assignment is stable."""
        global BRANCH_NAMES
        current_branches = self.all_branches()
        for b in current_branches:
            if b not in BRANCH_NAMES:
                BRANCH_NAMES.append(b)


def graph_from_server_data(server_data: dict) -> ConversationGraph:
    """Build a ConversationGraph from the server's /graph response."""
    g = ConversationGraph()
    nodes_raw = server_data.get("nodes", [])
    project = server_data.get("project", {})

    for raw in nodes_raw:
        node_id = raw["id"]
        kind = raw.get("kind", "turn")
        branch = kind if kind != "turn" else "main"
        tags: list[str] = []
        if kind == "merge":
            tags.append("merge")
        elif kind == "branch":
            tags.append("diverge")
        elif kind == "clear":
            tags.append("checkpoint")

        g.nodes[node_id] = GraphNode(
            id=node_id,
            summary=raw.get("title", "Untitled"),
            branch=branch,
            status=raw.get("status", "idle"),
            tags=tags,
        )

        # Build edges from parentIds
        for pid in raw.get("parentIds", []):
            g.edges.setdefault(pid, []).append(node_id)

    # Determine root (node with no parents)
    all_ids = set(g.nodes.keys())
    child_ids = set()
    for children in g.edges.values():
        child_ids.update(children)
    root_candidates = all_ids - child_ids
    g.root_id = next(iter(root_candidates)) if root_candidates else ""

    g.current_id = project.get("activeNodeId", "")
    g.update_branch_names()
    return g
