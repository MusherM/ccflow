"""DAG View — renders the conversation node tree with interactive navigation."""

from __future__ import annotations

from textual import events, on
from textual.binding import Binding
from textual.geometry import Offset
from textual.message import Message
from textual.reactive import reactive
from textual.strip import Strip
from textual.widget import Widget

from rich.color import Color
from rich.segment import Segment
from rich.style import Style

from ..models import ConversationGraph


class NodeSelected(Message):
    def __init__(self, node_id: str, selected: bool) -> None:
        super().__init__()
        self.node_id = node_id
        self.selected = selected


class NodeFocused(Message):
    def __init__(self, node_id: str) -> None:
        super().__init__()
        self.node_id = node_id


class NodeAction(Message):
    def __init__(self, action: str, node_id: str) -> None:
        super().__init__()
        self.action = action
        self.node_id = node_id


class DAGView(Widget, can_focus=True):
    """Interactive DAG tree view with keyboard/mouse navigation and multi-select."""

    DEFAULT_CSS = """
    DAGView {
        height: 1fr;
        overflow-y: auto;
        overflow-x: auto;
        background: $surface;
        padding: 0 1;
        scrollbar-size: 1 1;
    }
    """

    def __init__(self, graph: ConversationGraph, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.graph = graph
        self._focus_id = graph.current_id
        self._selected_ids: set[str] = set()
        self._node_rows: dict[str, int] = {}
        self._row_nodes: dict[int, str] = {}
        self._render_lines: list[str] = []
        self._total_rows = 0
        self._layout()

    @property
    def focus_id(self) -> str:
        return self._focus_id

    @focus_id.setter
    def focus_id(self, value: str) -> None:
        old = self._focus_id
        self._focus_id = value
        if old != value:
            self._scroll_to_node(value)
            self.refresh()

    @property
    def selected_ids(self) -> set[str]:
        return self._selected_ids

    @selected_ids.setter
    def selected_ids(self, value: set[str]) -> None:
        self._selected_ids = value
        self.refresh()

    def update_graph(self, graph: ConversationGraph) -> None:
        self.graph = graph
        self._focus_id = graph.current_id or self._focus_id
        self._layout()
        self.refresh()

    def _layout(self) -> None:
        self._node_rows.clear()
        self._row_nodes.clear()
        self._render_lines.clear()

        rows: list[str] = []

        def is_last_sibling(node_id: str) -> bool:
            parent = self.graph.parent_of(node_id)
            if parent is None:
                return True
            siblings = self.graph.children_of(parent)
            return siblings and siblings[-1] == node_id

        def visit(node_id: str, depth: int, inherited_prefix: str) -> None:
            is_last = is_last_sibling(node_id)
            if depth == 0:
                connector = ""
                child_prefix = ""
            elif is_last:
                connector = "┗"
                child_prefix = inherited_prefix + "  "
            else:
                connector = "┣"
                child_prefix = inherited_prefix + "┃ "

            self._render_lines.append(f"{inherited_prefix}{connector}")
            rows.append(node_id)

            for child in self.graph.children_of(node_id):
                visit(child, depth + 1, child_prefix)

        if self.graph.root_id:
            visit(self.graph.root_id, 0, "")

        for i, nid in enumerate(rows):
            self._node_rows[nid] = i
            self._row_nodes[i] = nid
        self._total_rows = len(rows)

    def _scroll_to_node(self, node_id: str) -> None:
        if node_id not in self._node_rows:
            return
        row = self._node_rows[node_id]
        target = max(0, row - 3)
        self.scroll_to(y=target, animate=False)

    def render_line(self, y: int) -> Strip:
        scroll_y = self.scroll_offset.y
        abs_y = y + scroll_y
        width = self.size.width
        if abs_y >= self._total_rows:
            return Strip.blank(width)

        node_id = self._row_nodes.get(abs_y)
        if node_id is None or node_id not in self.graph.nodes:
            return Strip.blank(width)

        node = self.graph.nodes[node_id]
        tree_part = self._render_lines[abs_y]
        is_focused = node_id == self.focus_id
        is_selected = node_id in self.selected_ids
        is_current = node_id == self.graph.current_id
        branch_color_str = self.graph.branch_color(node.branch)
        rich_color = Color.parse(branch_color_str)

        tree_style = Style(color=Color.from_ansi(8))
        segments = [Segment(tree_part, tree_style)]

        # Node indicator
        if is_current:
            indicator = "● "
        elif node.status == "completed" or node.status == "done":
            indicator = "○ "
        else:
            indicator = "◌ "

        # Label style
        if is_focused:
            label_style = Style(color=Color.from_ansi(0), bgcolor=rich_color, bold=True)
        elif is_selected:
            label_style = Style(color=rich_color, bgcolor=Color.from_ansi(11))
        else:
            label_style = Style(color=rich_color)

        segments.append(Segment(indicator + node.summary, label_style))

        # Branch tag
        if node.branch != "main":
            segments.append(Segment(f" [{node.branch}]", Style(color=rich_color, dim=True)))

        if is_current:
            if is_focused:
                segments.append(Segment(" ◀", Style(color=Color.from_ansi(0), bold=True)))
            else:
                segments.append(Segment(" ← 当前", Style(color=Color.from_ansi(2), bold=True)))

        if node.tags:
            tags_str = " " + " ".join(f"#{t}" for t in node.tags)
            segments.append(Segment(tags_str, Style(color=Color.from_ansi(3))))

        strip = Strip(segments)
        scroll_x = self.scroll_offset.x
        strip = strip.crop(scroll_x, scroll_x + width)
        return strip

    # ── Interaction ────────────────────────────────────────

    def _row_at_y(self, screen_y: int) -> str | None:
        return self._row_nodes.get(screen_y + self.scroll_offset.y)

    def _node_at(self, offset: Offset) -> str | None:
        return self._row_at_y(offset.y)

    @on(events.Click)
    def _on_click(self, event: events.Click) -> None:
        node_id = self._node_at(event.offset)
        if node_id is None:
            return
        self.focus_id = node_id
        if event.shift:
            if node_id in self.selected_ids:
                self.selected_ids.discard(node_id)
                self.post_message(NodeSelected(node_id, False))
            else:
                self.selected_ids.add(node_id)
                self.post_message(NodeSelected(node_id, True))
        elif event.meta or event.ctrl:
            self.selected_ids.add(node_id)
            self.post_message(NodeSelected(node_id, True))
        else:
            self.selected_ids.clear()
            self.focus_id = node_id
            self.post_message(NodeFocused(node_id))

    @on(events.Key)
    def _on_key(self, event: events.Key) -> None:
        key = event.key
        if key in ("up", "k"):
            self._move_focus(-1)
            event.prevent_default()
        elif key in ("down", "j"):
            self._move_focus(1)
            event.prevent_default()
        elif key == "space":
            if self.focus_id:
                if self.focus_id in self.selected_ids:
                    self.selected_ids.discard(self.focus_id)
                    self.post_message(NodeSelected(self.focus_id, False))
                else:
                    self.selected_ids.add(self.focus_id)
                    self.post_message(NodeSelected(self.focus_id, True))
            event.prevent_default()
        elif key == "enter":
            if self.focus_id:
                self.post_message(NodeAction("inspect", self.focus_id))
            event.prevent_default()
        elif key == "d":
            if self.focus_id:
                self.post_message(NodeAction("diverge", self.focus_id))
            event.prevent_default()
        elif key == "m":
            if self.selected_ids:
                self.post_message(NodeAction("merge", ",".join(sorted(self.selected_ids))))
            event.prevent_default()
        elif key == "c":
            if self.focus_id:
                self.post_message(NodeAction("continue", self.focus_id))
            event.prevent_default()
        elif key == "escape":
            self.selected_ids.clear()
            self.refresh()

    def _move_focus(self, delta: int) -> None:
        if not self._row_nodes:
            return
        if self.focus_id not in self._node_rows:
            self.focus_id = next(iter(self._row_nodes.values()))
            return
        current_row = self._node_rows[self.focus_id]
        new_row = max(0, min(self._total_rows - 1, current_row + delta))
        new_focus = self._row_nodes.get(new_row)
        if new_focus:
            self.focus_id = new_focus
            self.post_message(NodeFocused(new_focus))
