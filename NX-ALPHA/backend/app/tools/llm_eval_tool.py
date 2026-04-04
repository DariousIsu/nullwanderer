"""
llm_eval_tool.py
─────────────────
AURA MCP tool — LLM benchmark evaluation via lm-evaluation-harness.

Runs standardized benchmarks (MMLU, HellaSwag, TruthfulQA, etc.) against
local Ollama models or any HuggingFace model. Results are cached locally.

No API key required. Requires: pip install lm-eval
Models evaluated via Ollama (http://localhost:11434) by default.
"""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

_RESULTS_DIR = Path.home() / ".aura" / "eval_results"

# Common benchmark tasks and their descriptions
_TASK_INFO = {
    "mmlu":           "Massive Multitask Language Understanding — 57 academic subjects",
    "hellaswag":      "Commonsense reasoning — sentence completion",
    "truthfulqa_mc1": "TruthfulQA — measures truthfulness on 817 questions",
    "arc_easy":       "AI2 Reasoning Challenge — easy science questions",
    "arc_challenge":  "AI2 Reasoning Challenge — challenging science questions",
    "winogrande":     "Commonsense reasoning — pronoun disambiguation",
    "gsm8k":          "Grade school math word problems",
    "humaneval":      "Python code generation benchmark (164 problems)",
    "mbpp":           "Mostly Basic Python Programming — 374 problems",
}

TOOL_DEF = {
    "name": "llm_eval",
    "description": (
        "Run standardized LLM benchmarks using lm-evaluation-harness. "
        "Operations: run_benchmark (evaluate model on tasks), list_tasks (show available benchmarks), "
        "list_results (show cached eval results), get_result (read a specific result). "
        "Supported tasks: mmlu, hellaswag, truthfulqa_mc1, arc_easy, arc_challenge, gsm8k, humaneval. "
        "Evaluates local Ollama models or HuggingFace models."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["run_benchmark", "list_tasks", "list_results", "get_result"],
                "description": "Operation to perform",
            },
            "model": {
                "type": "string",
                "description": "Model name for run_benchmark. Ollama: 'ollama/qwen3:8b'. HuggingFace: 'hf/meta-llama/Llama-3.1-8B'.",
            },
            "tasks": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of benchmark tasks to run (e.g. ['mmlu', 'hellaswag'])",
            },
            "num_fewshot": {
                "type": "integer",
                "description": "Number of few-shot examples (default: 0 for zero-shot)",
                "default": 0,
            },
            "limit": {
                "type": "integer",
                "description": "Max examples per task (default: null = full benchmark). Use 100 for quick tests.",
            },
            "result_name": {
                "type": "string",
                "description": "Result filename to read (for get_result)",
            },
        },
        "required": ["operation"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    operation = inputs.get("operation", "list_tasks")

    if operation == "list_tasks":
        return {
            "tasks": [
                {"name": k, "description": v}
                for k, v in _TASK_INFO.items()
            ]
        }

    if operation == "list_results":
        _RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        files = sorted(_RESULTS_DIR.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True)
        return {
            "results": [
                {"name": f.name, "size_kb": round(f.stat().st_size / 1024, 1)}
                for f in files[:20]
            ]
        }

    if operation == "get_result":
        name = inputs.get("result_name", "")
        if not name:
            return {"error": "result_name required"}
        path = _RESULTS_DIR / name
        if not path.exists():
            return {"error": f"Result not found: {name}"}
        data = json.loads(path.read_text())
        # Return summary metrics only (full file can be huge)
        results = data.get("results", {})
        summary = {}
        for task, metrics in results.items():
            summary[task] = {k: v for k, v in metrics.items() if isinstance(v, (int, float))}
        return {"model": data.get("model_name", ""), "results": summary}

    if operation == "run_benchmark":
        model = inputs.get("model", "")
        tasks = inputs.get("tasks", [])
        if not model or not tasks:
            return {"error": "model and tasks required for run_benchmark"}

        # Check lm_eval is available
        try:
            import importlib.util
            if importlib.util.find_spec("lm_eval") is None:
                return {
                    "error": "lm-eval not installed",
                    "hint":  "pip install lm-eval",
                }
        except Exception:
            pass

        num_fewshot = int(inputs.get("num_fewshot", 0))
        limit       = inputs.get("limit")

        _RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        task_str    = ",".join(tasks)
        output_path = _RESULTS_DIR / f"eval_{model.replace('/', '-')}_{task_str[:30]}.json"

        cmd = [
            sys.executable, "-m", "lm_eval",
            "--model",          model.split("/")[0],   # "ollama" or "hf"
            "--model_args",     f"model={model.split('/', 1)[-1]},base_url=http://localhost:11434" if model.startswith("ollama") else f"pretrained={model.split('/', 1)[-1]}",
            "--tasks",          task_str,
            "--num_fewshot",    str(num_fewshot),
            "--output_path",    str(output_path),
            "--log_samples",
        ]
        if limit:
            cmd += ["--limit", str(limit)]

        logger.info("[llm_eval_tool] Running: %s", " ".join(cmd))

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=3600)
        except asyncio.TimeoutError:
            return {"error": "Benchmark timed out after 1 hour"}
        except Exception as exc:
            return {"error": f"Failed to run lm_eval: {exc}"}

        if proc.returncode != 0:
            err = stderr.decode(errors="replace")[-1000:]
            return {"error": f"lm_eval failed (exit {proc.returncode})", "stderr": err}

        if output_path.exists():
            data = json.loads(output_path.read_text())
            results = data.get("results", {})
            summary = {}
            for task, metrics in results.items():
                summary[task] = {k: v for k, v in metrics.items() if isinstance(v, (int, float))}
            return {
                "success":     True,
                "model":       model,
                "tasks":       tasks,
                "results":     summary,
                "output_file": str(output_path),
            }

        return {"success": True, "model": model, "tasks": tasks, "note": "Results written to " + str(output_path)}

    return {"error": f"Unknown operation: {operation}"}
