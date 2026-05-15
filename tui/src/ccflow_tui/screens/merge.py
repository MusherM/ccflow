"""Merge Preview Screen — shows source nodes before confirming merge."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Container, Horizontal
from textual.screen import ModalScreen
from textual.widgets import Button, Label, Static

from ..models import ConversationGraph


class MergeScreen(ModalScreen[bool]):
    DEFAULT_CSS = """
    MergeScreen {
        align: center middle;
    }
    MergeScreen > Container {
        width: 70%;
        height: 80%;
        background: $surface;
        border: solid $primary;
        padding: 1 2;
    }
    MergeScreen .merge-title {
        text-style: bold;
        color: $secondary;
        height: 1;
    }
    MergeScreen .merge-source {
        height: auto;
        margin: 1 0;
        padding: 1;
        border: solid $surface-lighten-1;
    }
    MergeScreen Button {
        margin: 0 1;
    }
    """

    def __init__(self, graph: ConversationGraph, source_ids: list[str]) -> None:
        super().__init__()
        self.graph = graph
        self.source_ids = source_ids

    def compose(self) -> ComposeResult:
        with Container():
            yield Label("⥣  合并预览 — Merge Preview", classes="merge-title")
            for sid in self.source_ids:
                if sid in self.graph.nodes:
                    node = self.graph.nodes[sid]
                    bc = self.graph.branch_color(node.branch)
                    text = f"[{bc}]● [{node.branch}][/] {node.summary}\n"
                    if node.files:
                        text += "  文件: " + ", ".join(node.files) + "\n"
                    if node.detail_lines:
                        text += "  " + "\n  ".join(node.detail_lines[:2])
                    yield Static(text, classes="merge-source")
            yield Label("\n合并后将创建新节点，连接所有源节点的最佳内容。")
            with Horizontal(id="merge-actions"):
                yield Button("✓ 确认合并", variant="success", id="btn-confirm")
                yield Button("✗ 取消", variant="error", id="btn-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-confirm":
            self.dismiss(True)
        else:
            self.dismiss(False)
