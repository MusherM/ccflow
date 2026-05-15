"""Session discovery — map cwd to CCFlow project/active-node.

Walks up the filesystem to locate the nearest .git directory (the repo root),
then asks the server to match that path against known projects.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Context:
    cwd: str
    repo_path: str
    project_id: str | None
    active_node_id: str | None


def find_git_root(cwd: str) -> str | None:
    """Walk upward from cwd to find the nearest .git directory."""
    path = os.path.abspath(cwd)
    while True:
        if os.path.isdir(os.path.join(path, ".git")):
            return path
        parent = os.path.dirname(path)
        if parent == path:
            return None
        path = parent


def resolve_context(cwd: str | None = None) -> Context:
    """Resolve the current working directory to a CCFlow project context.

    Returns a Context even when no CCFlow project is found (project_id /
    active_node_id will be None).
    """
    cwd = cwd or os.getcwd()
    repo_path = find_git_root(cwd) or cwd
    return Context(cwd=cwd, repo_path=repo_path, project_id=None, active_node_id=None)
