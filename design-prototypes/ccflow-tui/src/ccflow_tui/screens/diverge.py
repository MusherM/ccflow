"""Diverge Dialog Screen — input branch name and summary."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Container, Horizontal
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label

from ..models import ConversationGraph


class DivergeScreen(ModalScreen[str | None]):
    DEFAULT_CSS = """
    DivergeScreen {
        align: center middle;
    }
    DivergeScreen > Container {
        width: 50%;
        height: auto;
        background: $surface;
        border: solid $accent;
        padding: 1 2;
    }
    DivergeScreen Input {
        width: 100%;
        margin: 1 0;
    }
    DivergeScreen Button {
        margin: 0 1;
    }
    """

    def __init__(self, graph: ConversationGraph, source_id: str) -> None:
        super().__init__()
        self.graph = graph
        self.source_id = source_id
        self.source_node = graph.nodes.get(source_id)

    def compose(self) -> ComposeResult:
        src_summary = self.source_node.summary if self.source_node else self.source_id
        with Container():
            yield Label(f"⑂  分叉 — Diverge from: {src_summary}")
            yield Label("新分支名称:")
            yield Input(placeholder="feature-name", id="branch-input")
            yield Label("初始摘要:")
            yield Input(placeholder="描述这次探索的方向...", id="summary-input")
            with Horizontal(id="diverge-actions"):
                yield Button("✓ 创建分叉", variant="primary", id="btn-diverge-confirm")
                yield Button("✗ 取消", variant="error", id="btn-diverge-cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-diverge-confirm":
            branch_input = self.query_one("#branch-input", Input)
            summary_input = self.query_one("#summary-input", Input)
            branch = branch_input.value.strip() or "new-branch"
            summary = summary_input.value.strip() or "未命名探索"
            self.dismiss(f"{branch}::{summary}")
        else:
            self.dismiss(None)
