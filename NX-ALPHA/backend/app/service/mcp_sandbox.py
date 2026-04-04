"""
AURA NX-Alpha — MCP Sandbox (Phase 5b)

Runs the generated server.py as an MCP subprocess, sends golden set examples
as JSON-RPC tools/call requests via stdin, judges responses with Workhorse.

Distinct from Phase 3 wrapper sandbox (llm-sandbox Docker).
This tests the FINAL server.py via real MCP protocol.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_MCP_BASE    = Path.home() / ".aura" / "mcp_tools"
_SAMPLE_SIZE = 20
_PASS_RATE_GATE = 0.90
_STARTUP_TIMEOUT = 30.0
_CALL_TIMEOUT    = 10.0


def _get_ollama():
    try:
        from app.service.ollama_service import get_ollama_service
        return get_ollama_service()
    except Exception:
        return None


def _load_golden(tool_id: str) -> list[dict]:
    path = _MCP_BASE / tool_id / "golden_set.jsonl"
    entries: list[dict] = []
    if not path.exists():
        return entries
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except Exception:
                    pass
    return entries


def _server_path(tool_id: str) -> Path:
    return _MCP_BASE / tool_id / "mcp" / "server.py"


# ─────────────────────────────────────────────────────────────────────────────
# MCP JSON-RPC HELPERS
# ─────────────────────────────────────────────────────────────────────────────

async def _send_request(writer: asyncio.StreamWriter, method: str, params: dict, req_id: int) -> None:
    msg = json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
    writer.write((msg + "\n").encode("utf-8"))
    await writer.drain()


async def _read_response(reader: asyncio.StreamReader, timeout: float = _CALL_TIMEOUT) -> Optional[dict]:
    try:
        line = await asyncio.wait_for(reader.readline(), timeout=timeout)
        return json.loads(line.decode("utf-8").strip())
    except (asyncio.TimeoutError, json.JSONDecodeError, Exception) as exc:
        logger.debug("[mcp_sandbox] read_response failed: %s", exc)
        return None


async def _extract_inputs_from_golden(entry: dict, input_schema: dict) -> dict:
    """Build tool call inputs from a golden set example using the tool's input schema."""
    messages = entry.get("messages", [])
    user_content = next((m["content"] for m in messages if m["role"] == "user"), "")
    properties = input_schema.get("properties", {})
    if not properties:
        return {}
    # Simple heuristic: put the full prompt in the first string field
    first_str_field = next(
        (k for k, v in properties.items() if v.get("type") == "string"), None
    )
    if first_str_field:
        return {first_str_field: user_content}
    return {}


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC API
# ─────────────────────────────────────────────────────────────────────────────

async def run_sandbox(tool_id: str) -> dict:
    """
    Run Phase 5b sandbox:
    1. Start server.py subprocess (MCP stdio)
    2. Initialize MCP handshake
    3. Send golden set examples as tools/call requests
    4. Judge responses with Workhorse
    5. Return {sandbox_pass_rate, results, status}
    """
    from app.service.mcp_tool_store import get_mcp_tool_store
    store   = get_mcp_tool_store()
    tool    = store.get_tool(tool_id)
    ollama  = _get_ollama()

    if not tool:
        return {"error": "tool not found"}

    server_py = _server_path(tool_id)
    if not server_py.exists():
        return {"error": f"server.py not found at {server_py}"}

    golden = _load_golden(tool_id)
    if not golden:
        return {"error": "no golden set entries"}

    sample = random.sample(golden, min(_SAMPLE_SIZE, len(golden)))
    results: list[dict] = []

    proc = await asyncio.create_subprocess_exec(
        "python", str(server_py),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        reader = proc.stdout
        writer = proc.stdin

        # MCP initialize handshake
        await _send_request(writer, "initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "aura-sandbox", "version": "1.0"},
        }, req_id=0)

        init_resp = await _read_response(reader, timeout=_STARTUP_TIMEOUT)
        if not init_resp or "error" in init_resp:
            proc.kill()
            return {"error": "MCP initialize failed", "response": init_resp}

        # Get tool name from tools/list
        await _send_request(writer, "tools/list", {}, req_id=1)
        list_resp = await _read_response(reader)
        tool_name = tool_id  # default
        if list_resp:
            tools_list = list_resp.get("result", {}).get("tools", [])
            if tools_list:
                tool_name = tools_list[0].get("name", tool_id)

        # Run golden set examples
        for idx, entry in enumerate(sample):
            inputs = await _extract_inputs_from_golden(entry, tool.input_schema)
            messages = entry.get("messages", [])
            reference = next((m["content"] for m in messages if m["role"] == "assistant"), "")

            await _send_request(writer, "tools/call", {
                "name": tool_name,
                "arguments": inputs,
            }, req_id=idx + 10)

            response = await _read_response(reader)
            if response is None or "error" in (response or {}):
                results.append({
                    "input":     inputs,
                    "expected":  reference[:200],
                    "actual":    str(response),
                    "passed":    False,
                    "reason":    "error or timeout",
                })
                continue

            # Extract response text
            result_content = response.get("result", {})
            actual = ""
            if isinstance(result_content, dict):
                content_list = result_content.get("content", [])
                if content_list:
                    actual = content_list[0].get("text", str(result_content))
                else:
                    actual = json.dumps(result_content)
            else:
                actual = str(result_content)

            # Judge with Workhorse
            passed = False
            if ollama and reference:
                try:
                    from app.service.eval_runner import _judge_answer
                    judgment = await _judge_answer(
                        next((m["content"] for m in messages if m["role"] == "user"), ""),
                        reference, actual, 6, ollama,
                    )
                    passed = judgment["approved"]
                except Exception:
                    passed = bool(actual and "error" not in actual.lower())
            else:
                passed = bool(actual and "error" not in actual.lower())

            results.append({
                "input":    inputs,
                "expected": reference[:200],
                "actual":   actual[:400],
                "passed":   passed,
            })

    finally:
        try:
            proc.kill()
            await proc.wait()
        except Exception:
            pass

    total    = len(results)
    passed   = sum(1 for r in results if r["passed"])
    pass_rate = round(passed / max(total, 1), 3)

    # Advance stage
    if pass_rate >= _PASS_RATE_GATE:
        store.update_fields(tool_id, sandbox_pass_rate=pass_rate, stage="human_testing", blocking_reason=None)
    else:
        store.update_fields(
            tool_id,
            sandbox_pass_rate=pass_rate,
            stage="sandbox",
            blocking_reason=f"Sandbox {pass_rate:.0%} pass rate — review server.py",
        )

    return {
        "sandbox_pass_rate": pass_rate,
        "passed":  passed,
        "total":   total,
        "results": results,
        "stage":   "human_testing" if pass_rate >= _PASS_RATE_GATE else "sandbox",
    }
