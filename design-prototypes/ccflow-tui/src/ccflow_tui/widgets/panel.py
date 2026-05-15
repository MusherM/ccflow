"""Side Panel — shows focused node details, selection info, and keyboard help."""

from __future__ import annotations

from textual.widget import Widget

from rich.color import Color
from rich.style import Style
from rich.text import Text

from ..models import ConversationGraph


class SidePanel(Widget):
    DEFAULT_CSS = """
    SidePanel {
        width: 36;
        height: 1fr;
        background: $panel;
        border-left: solid $primary-background;
        padding: 1;
        overflow-y: auto;
    }
    """

    def __init__(self, graph: ConversationGraph, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.graph = graph
        self._focus_id = ""
        self._selected_ids: set[str] = set()

    @property
    def focus_id(self) -> str:
        return self._focus_id

    @focus_id.setter
    def focus_id(self, value: str) -> None:
        self._focus_id = value
        self.refresh()

    @property
    def selected_ids(self) -> set[str]:
        return self._selected_ids

    @selected_ids.setter
    def selected_ids(self, value: set[str]) -> None:
        self._selected_ids = value
        self.refresh()

    def render(self) -> Text:
        content = Text()

        fid = self.focus_id
        if fid and fid in self.graph.nodes:
            node = self.graph.nodes[fid]
            branch_color_str = self.graph.branch_color(node.branch)

            content.append("▸ 焦点节点\n", Style(bold=True, color=Color.from_ansi(4)))
            content.append(f"  {node.summary}\n", Style(bold=True))
            content.append(f"  id: {node.id[:8]}  ", Style(color=Color.from_ansi(8)))
            content.append(f"分支: ", Style(color=Color.from_ansi(8)))
            content.append(f"{node.branch}\n", Style(color=Color.parse(branch_color_str)))
            content.append(f"  状态: ", Style(color=Color.from_ansi(8)))
            s_color = {"active": 2, "running": 2, "completed": 8, "done": 8, "conflict": 1}.get(node.status, 7)
            content.append(f"{node.status}\n", Style(color=Color.from_ansi(s_color)))

            if node.files:
                content.append("\n  文件:\n", Style(color=Color.from_ansi(8)))
                for f in node.files:
                    content.append(f"    📄 {f}\n", Style(color=Color.from_ansi(2)))
            if node.tags:
                content.append("\n  标签: ", Style(color=Color.from_ansi(8)))
                content.append(" ".join(f"#{t}" for t in node.tags) + "\n",
                               Style(color=Color.from_ansi(3)))
            if node.detail_lines:
                content.append("\n  摘要:\n", Style(color=Color.from_ansi(8)))
                for line in node.detail_lines:
                    content.append(f"    · {line}\n", Style(color=Color.from_ansi(7)))
        else:
            content.append("← 在图中选择一个节点\n", Style(color=Color.from_ansi(8)))

        # ── Selection info ──
        if self.selected_ids:
            content.append("\n" + "─" * 34 + "\n")
            content.append("▸ 已选节点\n", Style(bold=True, color=Color.from_ansi(4)))
            branches_selected: set[str] = set()
            for sid in sorted(self.selected_ids):
                if sid in self.graph.nodes:
                    sn = self.graph.nodes[sid]
                    branches_selected.add(sn.branch)
                    bc = self.graph.branch_color(sn.branch)
                    content.append(f"  ● {sn.summary}", Style(color=Color.parse(bc)))
                    content.append(f" [{sn.branch}]\n", Style(color=Color.parse(bc), dim=True))
            content.append(
                f"\n  共 {len(self.selected_ids)} 个节点，{len(branches_selected)} 个分支\n",
                Style(color=Color.from_ansi(8)),
            )
            if len(branches_selected) >= 2:
                content.append("  ✅ 可合并 (按 M)\n", Style(color=Color.from_ansi(2), bold=True))
            else:
                content.append("  ⚠ 需要≥2个不同分支 (按 M)\n",
                               Style(color=Color.from_ansi(3)))

        # ── Key help ──
        content.append("\n" + "─" * 34 + "\n")
        content.append("▸ 快捷键\n", Style(bold=True, color=Color.from_ansi(4)))
        keys = [
            ("↑↓/j k", "移动焦点"),
            ("Space", "选中/取消"),
            ("Enter", "检视详情"),
            ("D", "分叉 (Diverge)"),
            ("M", "合并选中"),
            ("C", "继续会话"),
            ("Esc", "清除选择"),
            ("Shift+Click", "追加选择"),
            ("Q", "退出"),
            ("R", "刷新 graph"),
        ]
        for key, desc in keys:
            content.append(f"  {key:<14}", Style(color=Color.from_ansi(3)))
            content.append(f"{desc}\n", Style(color=Color.from_ansi(8)))

        return content
