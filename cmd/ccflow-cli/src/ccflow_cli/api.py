"""REST client for the CCFlow Node.js server."""

from __future__ import annotations

import json
import urllib.request
import urllib.error


class CCFlowAPI:
    def __init__(self, base_url: str = "http://127.0.0.1:4389") -> None:
        self.base_url = base_url

    def _get(self, path: str) -> dict:
        url = f"{self.base_url}{path}"
        req = urllib.request.Request(url, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception:
            return {}

    def _post(self, path: str, body: dict | None = None) -> dict:
        url = f"{self.base_url}{path}"
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

    def health(self) -> bool:
        resp = self._get("/api/health")
        return resp.get("ok", False)

    def project_lookup(self, cwd: str) -> dict:
        return self._post("/api/projects/lookup", {"cwd": cwd})

    def cclear(self, node_id: str, title: str) -> dict:
        return self._post(f"/api/nodes/{node_id}/cclear", {"title": title})

    def diverge(self, node_id: str, title: str) -> dict:
        return self._post(f"/api/nodes/{node_id}/diverge", {"title": title})

    def graph(self, project_id: str) -> dict:
        return self._post(f"/api/projects/{project_id}/graph")

    def merge(self, project_id: str, source_node_ids: list[str]) -> dict:
        return self._post(f"/api/projects/{project_id}/merge", {"sourceNodeIds": source_node_ids})
