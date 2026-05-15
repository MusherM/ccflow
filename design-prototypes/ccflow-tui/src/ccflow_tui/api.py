"""REST client for the TUI — fetches graph data from the CCFlow server."""

from __future__ import annotations

import json
import os
import urllib.request
import urllib.error

SERVER_URL = os.environ.get("CCFLOW_SERVER_URL", "http://127.0.0.1:4389")


def _get(path: str) -> dict:
    url = f"{SERVER_URL}{path}"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return {}


def _post(path: str, body: dict | None = None) -> dict:
    url = f"{SERVER_URL}{path}"
    data = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            return json.loads(body)
        except Exception:
            return {"ok": False, "error": body or str(e)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def fetch_graph(cwd: str | None = None) -> dict | None:
    """Fetch the full graph for the project containing *cwd*."""
    cwd = cwd or os.environ.get("CCFLOW_CWD", os.getcwd())
    lookup = _post("/api/projects/lookup", {"cwd": cwd})
    project = lookup.get("project")
    if not project:
        return None

    project_id = project["id"]
    return _get(f"/api/projects/{project_id}/graph")


def merge_nodes(project_id: str, source_ids: list[str]) -> dict:
    return _post(f"/api/projects/{project_id}/merge", {"sourceNodeIds": source_ids})


def diverge_node(node_id: str, title: str) -> dict:
    return _post(f"/api/nodes/{node_id}/diverge", {"title": title})


def cclear_node(node_id: str, title: str) -> dict:
    return _post(f"/api/nodes/{node_id}/cclear", {"title": title})
