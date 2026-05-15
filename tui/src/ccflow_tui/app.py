"""
CCFlow TUI — Claude Code Conversation Graph Manager.

Terminal UI for visualizing and managing the conversation workflow DAG.
Supports keyboard and mouse navigation, multi-select across branches,
diverge (fork), and merge operations.

Run:  cd tui && uv run ccflow-tui
"""

from __future__ import annotations

from textual import events, on
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import Screen
from textual.widgets import Footer, Header

from . import api as tui_api
from .models import ConversationGraph, graph_from_server_data
from .widgets.dag import DAGView, NodeAction, NodeFocused, NodeSelected
from .widgets.legend import BranchLegend
from .widgets.panel import SidePanel
from .screens.diverge import DivergeScreen
from .screens.merge import MergeScreen


class MainScreen(Screen):
    BINDINGS = [
        Binding("q", "quit", "退出", priority=True),
        Binding("r", "refresh", "刷新"),
        Binding("question_mark", "help", "帮助"),
    ]

    def __init__(self, graph: ConversationGraph, project_id: str = "") -> None:
        super().__init__()
        self.graph = graph
        self.project_id = project_id

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Horizontal():
            with Vertical(id="graph-area"):
                dag = DAGView(self.graph, id="dag-view")
                yield dag
                yield BranchLegend(self.graph, id="branch-legend")
            yield SidePanel(self.graph, id="side-panel")
        yield Footer()

    def on_mount(self) -> None:
        dag = self.query_one("#dag-view", DAGView)
        dag.focus()
        side = self.query_one("#side-panel", SidePanel)
        side.focus_id = dag.focus_id
        side.selected_ids = dag.selected_ids

    # ── Message handlers ──

    def on_node_focused(self, msg: NodeFocused) -> None:
        self.query_one("#side-panel", SidePanel).focus_id = msg.node_id

    def on_node_selected(self, msg: NodeSelected) -> None:
        dag = self.query_one("#dag-view", DAGView)
        self.query_one("#side-panel", SidePanel).selected_ids = dag.selected_ids

    def on_node_action(self, msg: NodeAction) -> None:
        if msg.action == "diverge":
            self._handle_diverge(msg.node_id)
        elif msg.action == "merge":
            self._handle_merge(msg.node_id.split(","))
        elif msg.action == "continue":
            self._handle_continue(msg.node_id)
        elif msg.action == "inspect":
            self._handle_inspect(msg.node_id)

    # ── Actions ──

    async def _handle_diverge(self, node_id: str) -> None:
        result = await self.app.push_screen_wait(DivergeScreen(self.graph, node_id))
        if result is None:
            self.notify("分叉已取消", severity="warning")
            return

        branch, summary = result.split("::", 1)
        api_result = tui_api.diverge_node(node_id, title=f"{branch}: {summary}")
        if api_result.get("ok"):
            self._reload_graph()
            wp = api_result.get("worktree_path", "")
            self.notify(f"⑂ 分叉已创建: [{branch}] worktree: {wp}", severity="information")
        else:
            self.notify(f"分叉失败: {api_result.get('error', 'Unknown')}", severity="error")

    async def _handle_merge(self, source_ids: list[str]) -> None:
        branches: set[str] = set()
        valid_ids: list[str] = []
        for sid in source_ids:
            if sid in self.graph.nodes:
                branches.add(self.graph.nodes[sid].branch)
                valid_ids.append(sid)

        if len(branches) < 2:
            self.notify("⚠ 需要选择至少 2 个不同分支的节点", severity="warning")
            return

        confirmed = await self.app.push_screen_wait(MergeScreen(self.graph, valid_ids))
        if not confirmed:
            self.notify("合并已取消", severity="warning")
            return

        api_result = tui_api.merge_nodes(self.project_id, valid_ids)
        if api_result.get("node"):
            self._reload_graph()
            merge_result = api_result.get("mergeResult", {})
            if merge_result.get("clean"):
                self.notify("⥣ 合并完成", severity="information")
            else:
                conflicts = merge_result.get("conflicts", [])
                self.notify(f"⚠ 合并冲突: {len(conflicts)} 个文件", severity="warning")
        else:
            self.notify(f"合并失败: {api_result.get('error', 'Unknown')}", severity="error")

    def _handle_continue(self, node_id: str) -> None:
        old = self.graph.current_id
        self.graph.current_id = node_id
        if node_id in self.graph.nodes:
            self.graph.nodes[node_id].status = "active"
        if old in self.graph.nodes and self.graph.nodes[old].status == "active":
            self.graph.nodes[old].status = "completed"
        self.query_one("#dag-view", DAGView).refresh()
        self.query_one("#branch-legend", BranchLegend).refresh()
        self.notify(f"▶ 继续会话: {self.graph.nodes[node_id].summary}")

    def _handle_inspect(self, node_id: str) -> None:
        node = self.graph.nodes.get(node_id)
        if node:
            msg = f"📋 {node.summary}\n"
            msg += f"   分支: {node.branch} | 状态: {node.status} | "
            msg += f"标签: {', '.join(node.tags) or '无'}"
            self.notify(msg, title=f"节点: {node_id[:8]}", timeout=10)

    def _reload_graph(self) -> None:
        """Re-fetch graph from server and update all widgets."""
        data = tui_api.fetch_graph()
        if data:
            new_graph = graph_from_server_data(data)
            self.graph = new_graph
            dag = self.query_one("#dag-view", DAGView)
            dag.graph = new_graph
            dag._layout()
            dag.refresh()
            side = self.query_one("#side-panel", SidePanel)
            side.graph = new_graph
            side.focus_id = dag.focus_id
            side.refresh()
            self.query_one("#branch-legend", BranchLegend).graph = new_graph
            self.query_one("#branch-legend", BranchLegend).refresh()
            self.notify("Graph 已刷新", timeout=2)
        else:
            self.notify("无法连接到 CCFlow server", severity="error")

    def action_refresh(self) -> None:
        self._reload_graph()

    def action_help(self) -> None:
        self.notify(
            "↑↓/jk:导航  Space:选中  D:分叉  M:合并  C:继续  R:刷新  Enter:详情  Esc:清除  Q:退出",
            title="快捷键",
            timeout=10,
        )


class CCFlowTUI(App):
    TITLE = "CCFlow"
    SUB_TITLE = "Node Manager"

    CSS = """
    #graph-area {
        width: 1fr;
        height: 1fr;
    }
    #graph-area > DAGView {
        height: 1fr;
    }
    #side-panel {
        width: 36;
        height: 1fr;
    }
    """

    def on_mount(self) -> None:
        data = tui_api.fetch_graph()
        if data:
            graph = graph_from_server_data(data)
            project_id = data.get("project", {}).get("id", "")
            self.push_screen(MainScreen(graph, project_id))
        else:
            from .models import ConversationGraph
            self.push_screen(MainScreen(ConversationGraph(), ""))
            self.notify("无法连接到 CCFlow server — 显示空图", severity="warning")


def main() -> None:
    CCFlowTUI().run()


if __name__ == "__main__":
    main()
