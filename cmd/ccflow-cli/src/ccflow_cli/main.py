"""
CCFlow CLI — Claude Code 工作流管理命令行工具。

cc 通过 Bash tool 调用本 CLI：
  uv run ccflow cclear --summary "摘要"
  uv run ccflow diverge --name "分支名" --summary "摘要"

用户直接运行：
  uv run ccflow init   初始化项目
  uv run ccflow tui    启动 TUI 节点管理器
  uv run ccflow status 查看当前图状态
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

from .api import CCFlowAPI
from .session import resolve_context
from .terminal import open_terminal


SERVER_URL = "http://127.0.0.1:4389"


def ensure_server() -> CCFlowAPI:
    """Ensure the Node.js server is running and return an API client."""
    api = CCFlowAPI(SERVER_URL)
    if api.health():
        return api

    # Start server in background
    repo_root = os.environ.get("CCFLOW_REPO", _find_ccflow_root())
    server_dir = os.path.join(repo_root, "server")
    subprocess.Popen(
        ["npx", "tsx", "src/index.ts"],
        cwd=server_dir,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )

    # Wait for ready
    for _ in range(30):
        if api.health():
            return api
        time.sleep(0.2)

    # One last try
    if api.health():
        return api
    print(json.dumps({"ok": False, "error": "Server did not start within 6 seconds"}))
    sys.exit(1)


def _find_ccflow_root() -> str:
    # Try to locate CCFlow repo relative to this file
    this_dir = os.path.dirname(os.path.abspath(__file__))
    # Walk up until we find package.json + server/src/git.ts
    cur = this_dir
    for _ in range(10):
        if os.path.isfile(os.path.join(cur, "package.json")) and os.path.isfile(
            os.path.join(cur, "server", "src", "git.ts")
        ):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return os.getcwd()


# ── Subcommands ──────────────────────────────────────────

def cmd_cclear(args: argparse.Namespace) -> None:
    ctx = resolve_context(args.cwd)
    if not ctx.repo_path:
        print(json.dumps({"ok": False, "error": "Not in a git repository"}))
        sys.exit(1)

    api = ensure_server()
    lookup = api.project_lookup(ctx.repo_path)
    active = lookup.get("activeNode")
    if not active:
        print(json.dumps({"ok": False, "error": "No CCFlow project found for this directory. Run: ccflow init"}))
        sys.exit(1)

    title = args.summary or "Checkpoint"
    node_id = active["id"]
    result = api.cclear(node_id, title)
    if result.get("ok"):
        node = result["node"]
        print(
            json.dumps(
                {
                    "ok": True,
                    "node_id": node["id"],
                    "title": node["title"],
                    "branch": "main",
                    "commit": result.get("commit", "")[:7],
                }
            )
        )
    else:
        print(json.dumps({"ok": False, "error": result.get("error", "Unknown error")}))
        sys.exit(1)


def cmd_diverge(args: argparse.Namespace) -> None:
    ctx = resolve_context(args.cwd)
    if not ctx.repo_path:
        print(json.dumps({"ok": False, "error": "Not in a git repository"}))
        sys.exit(1)

    api = ensure_server()
    lookup = api.project_lookup(ctx.repo_path)
    active = lookup.get("activeNode")
    if not active:
        print(json.dumps({"ok": False, "error": "No CCFlow project found. Run: ccflow init"}))
        sys.exit(1)

    title = args.summary or args.name or "Diverge"
    node_id = active["id"]
    result = api.diverge(node_id, title)
    if result.get("ok"):
        node = result["node"]
        worktree = result.get("worktreePath", "")
        branch = result.get("branchName", "")

        # Open a new terminal in the worktree
        opened = False
        if worktree:
            opened = open_terminal(worktree, "cc")

        print(
            json.dumps(
                {
                    "ok": True,
                    "node_id": node["id"],
                    "title": node["title"],
                    "branch": branch,
                    "worktree_path": worktree,
                    "terminal_opened": opened,
                }
            )
        )
    else:
        print(json.dumps({"ok": False, "error": result.get("error", "Unknown error")}))
        sys.exit(1)


def cmd_init(args: argparse.Namespace) -> None:
    cwd = args.cwd or os.getcwd()
    ctx = resolve_context(cwd)
    api = ensure_server()

    # Ensure the project exists in the server
    lookup = api.project_lookup(ctx.repo_path)
    if not lookup.get("activeNode"):
        result = api._post("/api/projects/open", {"repoPath": ctx.repo_path})
        if not result.get("project"):
            print(f"初始化失败: {result.get('error', 'Unknown')}")
            sys.exit(1)
        print(f"CCFlow 项目已初始化: {result['project']['name']}")

    # Install slash commands into the project's .claude/commands/
    _install_slash_commands(ctx.repo_path)
    print(f"CCFlow 就绪: {ctx.repo_path}")


def _install_slash_commands(repo_path: str) -> None:
    """Copy slash command templates into .claude/commands/ with correct paths."""
    import shutil

    commands_dir = os.path.join(repo_path, ".claude", "commands", "ccflow")
    os.makedirs(commands_dir, exist_ok=True)

    source_dir = os.path.join(_find_ccflow_root(), "commands")
    if not os.path.isdir(source_dir):
        print(f"  警告: 未找到命令模板目录 {source_dir}")
        return

    ccflow_root = _find_ccflow_root()
    for fname in ["cclear.md", "diverge.md"]:
        src = os.path.join(source_dir, fname)
        dst = os.path.join(commands_dir, fname)
        if os.path.isfile(src):
            content = open(src).read().replace("__CCFLOW_ROOT__", ccflow_root)
            open(dst, "w").write(content)
            print(f"  已安装: .claude/commands/ccflow/{fname}")


def cmd_tui(args: argparse.Namespace) -> None:
    """Launch the Textual TUI."""
    # Ensure server runs first
    ensure_server()

    # The TUI lives in tui/
    cwd = args.cwd or os.getcwd()
    repo_root = _find_ccflow_root()
    tui_dir = os.path.join(repo_root, "tui")

    os.environ["CCFLOW_CWD"] = cwd
    os.environ["CCFLOW_SERVER_URL"] = SERVER_URL

    subprocess.run(
        ["uv", "run", "--directory", tui_dir, "ccflow-tui"],
        env={**os.environ, "CCFLOW_CWD": cwd, "CCFLOW_SERVER_URL": SERVER_URL},
    )


def cmd_status(args: argparse.Namespace) -> None:
    ctx = resolve_context(args.cwd)
    api = ensure_server()
    lookup = api.project_lookup(ctx.repo_path)
    project = lookup.get("project")
    active = lookup.get("activeNode")

    if not project:
        print("未找到 CCFlow 项目。运行 'ccflow init' 初始化。")
        return

    print(f"项目: {project['name']}")
    print(f"路径: {project['repoPath']}")
    if active:
        print(f"活跃节点: [{active['id'][:8]}] {active['title']}")
        print(f"  分支: {active.get('kind', 'N/A')}  状态: {active.get('status', 'N/A')}")


def cmd_daemon(_args: argparse.Namespace) -> None:
    """Start the server if not running (mostly called internally)."""
    api = ensure_server()
    print("CCFlow server is running.")


# ── main ────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(prog="ccflow", description="CCFlow CLI - Claude Code Workflow Manager")
    sub = parser.add_subparsers(dest="command")

    # cclear
    p_clear = sub.add_parser("cclear", help="创建 checkpoint 节点并 git commit")
    p_clear.add_argument("--summary", default="", help="会话摘要（节点标题）")
    p_clear.add_argument("--cwd", help="工作目录（自动检测）")

    # diverge
    p_div = sub.add_parser("diverge", help="从当前节点分叉创建平级探索分支")
    p_div.add_argument("--name", default="", help="探索分支名称")
    p_div.add_argument("--summary", default="", help="会话摘要")
    p_div.add_argument("--cwd", help="工作目录（自动检测）")

    # init
    p_init = sub.add_parser("init", help="初始化当前项目的 CCFlow")
    p_init.add_argument("--cwd", help="项目路径")

    # tui
    p_tui = sub.add_parser("tui", help="启动节点管理 TUI")
    p_tui.add_argument("--cwd", help="工作目录")

    # status
    p_stat = sub.add_parser("status", help="查看当前项目状态")
    p_stat.add_argument("--cwd", help="工作目录")

    # daemon
    sub.add_parser("daemon", help="启动后台 server")

    args = parser.parse_args()

    commands = {
        "cclear": cmd_cclear,
        "diverge": cmd_diverge,
        "init": cmd_init,
        "tui": cmd_tui,
        "status": cmd_status,
        "daemon": cmd_daemon,
    }

    handler = commands.get(args.command)
    if handler:
        handler(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
