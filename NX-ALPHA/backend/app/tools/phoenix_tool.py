"""
phoenix_tool.py
────────────────
AURA MCP tool — Arize Phoenix LLM observability and evaluation.

Instruments LLM calls with OpenTelemetry spans, evaluates response quality
(hallucination, toxicity, relevance), and provides trace inspection for
debugging prompt/response pipelines.

No API key required for self-hosted. Requires: pip install arize-phoenix
Launch Phoenix: python -m phoenix.server.main serve (default port 6006)
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_PHOENIX_HOST = "http://localhost:6006"

TOOL_DEF = {
    "name": "phoenix_eval",
    "description": (
        "LLM observability and evaluation via Arize Phoenix. "
        "Operations: log_span (record LLM call trace), eval_response (score quality), "
        "list_traces (view recent LLM calls), get_trace (inspect specific trace), status (health check). "
        "Tracks: latency, token usage, hallucination scores, relevance scores. "
        "Run Phoenix locally: python -m phoenix.server.main serve"
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["log_span", "eval_response", "list_traces", "get_trace", "status"],
                "description": "Phoenix operation",
            },
            "span_name": {
                "type": "string",
                "description": "Name for the span (for log_span)",
            },
            "input": {
                "type": "string",
                "description": "LLM input/prompt text (for log_span or eval_response)",
            },
            "output": {
                "type": "string",
                "description": "LLM output/response text (for log_span or eval_response)",
            },
            "model": {
                "type": "string",
                "description": "Model name (for log_span)",
            },
            "latency_ms": {
                "type": "number",
                "description": "Response latency in milliseconds (for log_span)",
            },
            "trace_id": {
                "type": "string",
                "description": "Trace ID to inspect (for get_trace)",
            },
            "limit": {
                "type": "integer",
                "description": "Max traces to return (default: 10)",
                "default": 10,
            },
        },
        "required": ["operation"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    operation = inputs.get("operation", "status")

    # ── Status check — just verify Phoenix is reachable ──────────────────────
    if operation == "status":
        try:
            import httpx
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{_PHOENIX_HOST}/healthz")
                if resp.status_code == 200:
                    return {"status": "online", "url": _PHOENIX_HOST}
                return {"status": "unreachable", "code": resp.status_code}
        except Exception as exc:
            return {
                "status": "offline",
                "url":    _PHOENIX_HOST,
                "error":  str(exc),
                "hint":   "Start Phoenix: python -m phoenix.server.main serve",
            }

    # ── eval_response — use Phoenix's built-in LLM evaluators ─────────────────
    if operation == "eval_response":
        input_text  = inputs.get("input", "")
        output_text = inputs.get("output", "")
        if not input_text or not output_text:
            return {"error": "input and output required for eval_response"}

        try:
            import phoenix.evals as evals
            # Relevance: does output address the input?
            relevance_template = evals.RelevanceEvaluator()
            # Hallucination: does output contain unsupported claims?
            hallucination_template = evals.HallucinationEvaluator()

            # Build minimal dataframe for evaluation
            import pandas as pd
            df = pd.DataFrame([{"input": input_text, "output": output_text}])

            rel_result  = evals.run_evals(df, evaluators=[relevance_template],    provide_explanation=True)
            hall_result = evals.run_evals(df, evaluators=[hallucination_template], provide_explanation=True)

            return {
                "relevance":      rel_result.iloc[0].to_dict()  if not rel_result.empty  else {},
                "hallucination":  hall_result.iloc[0].to_dict() if not hall_result.empty else {},
            }
        except ImportError:
            return {"error": "arize-phoenix not installed — run: pip install arize-phoenix"}
        except Exception as exc:
            logger.error("[phoenix_tool] eval_response failed: %s", exc)
            return {"error": str(exc)}

    # ── log_span — record an LLM call trace via REST ──────────────────────────
    if operation == "log_span":
        try:
            import httpx, time
            span_data = {
                "name":        inputs.get("span_name", "llm_call"),
                "span_kind":   "LLM",
                "start_time":  time.time() * 1e9,
                "attributes":  {
                    "llm.input.messages":  [{"role": "user", "content": inputs.get("input", "")}],
                    "llm.output.messages": [{"role": "assistant", "content": inputs.get("output", "")}],
                    "llm.model_name":      inputs.get("model", "unknown"),
                    "latency_ms":          inputs.get("latency_ms", 0),
                },
            }
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.post(f"{_PHOENIX_HOST}/v1/spans", json=span_data)
                if resp.status_code in (200, 201):
                    return {"success": True, "span_id": resp.json().get("span_id", "")}
                return {"error": f"Phoenix returned {resp.status_code}", "body": resp.text[:200]}
        except ImportError:
            return {"error": "httpx not installed"}
        except Exception as exc:
            return {"error": str(exc)}

    # ── list_traces / get_trace — query Phoenix API ────────────────────────────
    if operation in ("list_traces", "get_trace"):
        try:
            import httpx
            async with httpx.AsyncClient(timeout=10.0) as client:
                if operation == "list_traces":
                    limit = int(inputs.get("limit", 10))
                    resp  = await client.get(f"{_PHOENIX_HOST}/v1/traces?limit={limit}")
                else:
                    trace_id = inputs.get("trace_id", "")
                    if not trace_id:
                        return {"error": "trace_id required for get_trace"}
                    resp = await client.get(f"{_PHOENIX_HOST}/v1/traces/{trace_id}")

                if resp.status_code == 200:
                    return resp.json()
                return {"error": f"Phoenix returned {resp.status_code}"}
        except Exception as exc:
            return {"error": str(exc)}

    return {"error": f"Unknown operation: {operation}"}
