"""
Slack — MCP tool wrapper.

Send messages, list channels, read threads. Requires Bot Token.
"""

from __future__ import annotations

import logging
from app.tools._mcp_wrapper import _get_setting, _error

import httpx

logger = logging.getLogger(__name__)

_BASE = "https://slack.com/api"

TOOL_DEF = {
    "name": "slack",
    "description": (
        "Interact with Slack: send messages, list channels, read channel history, "
        "and post to threads. Requires a Slack Bot Token."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action":  {"type": "string", "enum": ["send_message", "list_channels", "channel_history", "reply_thread"], "description": "Slack action"},
            "channel": {"type": "string", "description": "Channel ID or name"},
            "text":    {"type": "string", "description": "Message text"},
            "thread_ts": {"type": "string", "description": "Thread timestamp (for reply_thread)"},
            "limit":   {"type": "integer", "default": 20},
        },
        "required": ["action"],
    },
}


def _headers() -> dict:
    token = _get_setting("slack_bot_token")
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"} if token else {}


async def tool_handler(inputs: dict) -> dict:
    action = inputs.get("action", "")
    token = _get_setting("slack_bot_token")
    if not token:
        return _error("slack_bot_token not configured in settings")

    try:
        async with httpx.AsyncClient(timeout=10.0, headers=_headers()) as client:

            if action == "list_channels":
                r = await client.get(f"{_BASE}/conversations.list", params={"limit": inputs.get("limit", 20)})
                r.raise_for_status()
                data = r.json()
                channels = [{"id": c["id"], "name": c["name"], "topic": c.get("topic", {}).get("value", "")} for c in data.get("channels", [])]
                return {"channels": channels, "count": len(channels)}

            elif action == "send_message":
                channel = inputs.get("channel", "")
                text = inputs.get("text", "")
                if not channel or not text:
                    return _error("channel and text required")
                r = await client.post(f"{_BASE}/chat.postMessage", json={"channel": channel, "text": text})
                r.raise_for_status()
                data = r.json()
                return {"ok": data.get("ok"), "ts": data.get("ts", ""), "channel": channel}

            elif action == "channel_history":
                channel = inputs.get("channel", "")
                if not channel:
                    return _error("channel required")
                r = await client.get(f"{_BASE}/conversations.history", params={"channel": channel, "limit": inputs.get("limit", 20)})
                r.raise_for_status()
                data = r.json()
                messages = [{"user": m.get("user", ""), "text": m.get("text", "")[:500], "ts": m.get("ts", "")} for m in data.get("messages", [])]
                return {"messages": messages, "count": len(messages)}

            elif action == "reply_thread":
                channel = inputs.get("channel", "")
                text = inputs.get("text", "")
                ts = inputs.get("thread_ts", "")
                if not all([channel, text, ts]):
                    return _error("channel, text, and thread_ts required")
                r = await client.post(f"{_BASE}/chat.postMessage", json={"channel": channel, "text": text, "thread_ts": ts})
                r.raise_for_status()
                data = r.json()
                return {"ok": data.get("ok"), "ts": data.get("ts", "")}

            return _error(f"Unknown action: {action}")

    except Exception as exc:
        logger.error("[slack_api] %s", exc)
        return _error(str(exc))
