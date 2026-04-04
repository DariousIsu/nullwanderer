"""
GitHub — MCP tool wrapper.

Search repos, manage issues, list PRs, search code.
Uses Personal Access Token (already in AURA settings as github_token).
"""

from __future__ import annotations

import logging
from app.tools._mcp_wrapper import _get_setting, _error

import httpx

logger = logging.getLogger(__name__)

_BASE = "https://api.github.com"

TOOL_DEF = {
    "name": "github",
    "description": (
        "Interact with GitHub: search repositories, manage issues, list pull requests, "
        "search code across repos. Requires a Personal Access Token."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["search_repos", "search_code", "list_issues", "get_issue", "create_issue", "list_prs", "get_repo"],
                "description": "GitHub action to perform",
            },
            "query":  {"type": "string", "description": "Search query (for search actions)"},
            "owner":  {"type": "string", "description": "Repository owner (for repo-specific actions)"},
            "repo":   {"type": "string", "description": "Repository name"},
            "number": {"type": "integer", "description": "Issue/PR number (for get_issue)"},
            "title":  {"type": "string", "description": "Issue title (for create_issue)"},
            "body":   {"type": "string", "description": "Issue body (for create_issue)"},
            "limit":  {"type": "integer", "default": 10},
        },
        "required": ["action"],
    },
}


def _headers() -> dict:
    token = _get_setting("github_token")
    h = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


async def tool_handler(inputs: dict) -> dict:
    action = inputs.get("action", "")
    if not action:
        return _error("action is required")

    try:
        async with httpx.AsyncClient(timeout=15.0, headers=_headers()) as client:

            if action == "search_repos":
                q = inputs.get("query", "")
                if not q:
                    return _error("query required for search_repos")
                r = await client.get(f"{_BASE}/search/repositories", params={"q": q, "per_page": inputs.get("limit", 10)})
                r.raise_for_status()
                data = r.json()
                repos = [{"name": i["full_name"], "description": i.get("description", "")[:200], "stars": i["stargazers_count"], "url": i["html_url"], "language": i.get("language")} for i in data.get("items", [])]
                return {"repos": repos, "total": data.get("total_count", 0)}

            elif action == "search_code":
                q = inputs.get("query", "")
                if not q:
                    return _error("query required for search_code")
                r = await client.get(f"{_BASE}/search/code", params={"q": q, "per_page": inputs.get("limit", 10)})
                r.raise_for_status()
                data = r.json()
                files = [{"path": i["path"], "repo": i["repository"]["full_name"], "url": i["html_url"]} for i in data.get("items", [])]
                return {"files": files, "total": data.get("total_count", 0)}

            elif action == "list_issues":
                owner, repo = inputs.get("owner", ""), inputs.get("repo", "")
                if not owner or not repo:
                    return _error("owner and repo required")
                r = await client.get(f"{_BASE}/repos/{owner}/{repo}/issues", params={"per_page": inputs.get("limit", 10), "state": "open"})
                r.raise_for_status()
                issues = [{"number": i["number"], "title": i["title"], "state": i["state"], "user": i["user"]["login"], "url": i["html_url"]} for i in r.json()]
                return {"issues": issues, "count": len(issues)}

            elif action == "get_issue":
                owner, repo, num = inputs.get("owner", ""), inputs.get("repo", ""), inputs.get("number")
                if not all([owner, repo, num]):
                    return _error("owner, repo, and number required")
                r = await client.get(f"{_BASE}/repos/{owner}/{repo}/issues/{num}")
                r.raise_for_status()
                i = r.json()
                return {"number": i["number"], "title": i["title"], "body": i.get("body", "")[:2000], "state": i["state"], "labels": [l["name"] for l in i.get("labels", [])], "url": i["html_url"]}

            elif action == "create_issue":
                owner, repo = inputs.get("owner", ""), inputs.get("repo", "")
                title = inputs.get("title", "")
                if not all([owner, repo, title]):
                    return _error("owner, repo, and title required")
                r = await client.post(f"{_BASE}/repos/{owner}/{repo}/issues", json={"title": title, "body": inputs.get("body", "")})
                r.raise_for_status()
                i = r.json()
                return {"number": i["number"], "url": i["html_url"], "created": True}

            elif action == "list_prs":
                owner, repo = inputs.get("owner", ""), inputs.get("repo", "")
                if not owner or not repo:
                    return _error("owner and repo required")
                r = await client.get(f"{_BASE}/repos/{owner}/{repo}/pulls", params={"per_page": inputs.get("limit", 10), "state": "open"})
                r.raise_for_status()
                prs = [{"number": p["number"], "title": p["title"], "user": p["user"]["login"], "url": p["html_url"], "draft": p.get("draft", False)} for p in r.json()]
                return {"pull_requests": prs, "count": len(prs)}

            elif action == "get_repo":
                owner, repo = inputs.get("owner", ""), inputs.get("repo", "")
                if not owner or not repo:
                    return _error("owner and repo required")
                r = await client.get(f"{_BASE}/repos/{owner}/{repo}")
                r.raise_for_status()
                d = r.json()
                return {"name": d["full_name"], "description": d.get("description", ""), "stars": d["stargazers_count"], "forks": d["forks_count"], "language": d.get("language"), "url": d["html_url"], "topics": d.get("topics", [])}

            return _error(f"Unknown action: {action}")

    except Exception as exc:
        logger.error("[github_api] %s", exc)
        return _error(str(exc))
