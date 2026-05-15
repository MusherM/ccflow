"""Branch Legend Bar — displays color legend for all branches."""

from __future__ import annotations

from textual.strip import Strip
from textual.widget import Widget

from rich.color import Color
from rich.segment import Segment
from rich.style import Style

from ..models import ConversationGraph


class BranchLegend(Widget):
    DEFAULT_CSS = """
    BranchLegend {
        height: 1;
        dock: bottom;
        background: $panel;
        padding: 0 1;
    }
    """

    def __init__(self, graph: ConversationGraph, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.graph = graph

    def render_line(self, y: int) -> Strip:
        width = self.size.width
        segments: list[Segment] = [Segment("分支: ", Style(color=Color.from_ansi(8)))]

        for branch in self.graph.all_branches():
            color = self.graph.branch_color(branch)
            segments.append(Segment("● ", Style(color=Color.parse(color), bold=True)))
            segments.append(Segment(f"{branch}  ", Style(color=Color.parse(color))))

        cur_node = self.graph.nodes.get(self.graph.current_id)
        if cur_node:
            segments.append(Segment("  │  ", Style(color=Color.from_ansi(8))))
            segments.append(Segment("● 当前活跃 ", Style(color=Color.from_ansi(2), bold=True)))
            short = cur_node.summary[:50]
            segments.append(Segment(f"= {short}", Style(color=Color.from_ansi(7))))

        strip = Strip(segments)
        if strip.cell_length < width:
            padding = " " * (width - strip.cell_length)
            strip = Strip([*strip.segments, Segment(padding)])
        return strip
