"""
huggingface_tool.py
────────────────────
AURA MCP tool — HuggingFace Hub model and dataset search.

Search models and datasets on HuggingFace Hub, read model cards,
get download stats, and inspect dataset previews. Free, no API key
required for public resources (key speeds up rate limits).

Requires: pip install huggingface_hub (already in requirements.txt)
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "huggingface",
    "description": (
        "Search and inspect HuggingFace Hub models and datasets. "
        "Operations: search_models (filter by task, library, language), "
        "get_model (card, metadata, downloads, likes), "
        "search_datasets (by task or keyword), "
        "get_dataset (card, splits, size), "
        "list_model_files (files in a repo). "
        "Free for public resources. Useful for finding models for fine-tuning or deployment."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["search_models", "get_model", "search_datasets", "get_dataset", "list_model_files"],
                "description": "Operation to perform",
            },
            "query": {
                "type": "string",
                "description": "Search query (for search_models, search_datasets)",
            },
            "model_id": {
                "type": "string",
                "description": "HuggingFace model ID, e.g. 'meta-llama/Llama-3.1-8B' (for get_model, list_model_files)",
            },
            "dataset_id": {
                "type": "string",
                "description": "HuggingFace dataset ID (for get_dataset)",
            },
            "task": {
                "type": "string",
                "description": "Task filter, e.g. 'text-generation', 'image-classification', 'fill-mask' (for search_models/datasets)",
            },
            "library": {
                "type": "string",
                "description": "Library filter, e.g. 'transformers', 'diffusers', 'gguf' (for search_models)",
            },
            "limit": {
                "type": "integer",
                "description": "Max results (default: 10)",
                "default": 10,
            },
            "sort": {
                "type": "string",
                "enum": ["downloads", "likes", "trending", "created_at", "modified"],
                "description": "Sort order (default: downloads)",
                "default": "downloads",
            },
        },
        "required": ["operation"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    operation = inputs.get("operation", "")
    limit     = int(inputs.get("limit", 10))

    try:
        from huggingface_hub import HfApi
        api = HfApi()
    except ImportError:
        return {"error": "huggingface_hub not installed — run: pip install huggingface_hub"}

    try:
        if operation == "search_models":
            query   = inputs.get("query", "")
            task    = inputs.get("task")
            library = inputs.get("library")
            sort    = inputs.get("sort", "downloads")

            # Note: task= and library= removed in newer huggingface_hub versions
            # Append them to the search query for filtering
            search_q = " ".join(filter(None, [query, task, library]))
            models = api.list_models(
                search=search_q or None,
                sort=sort,
                limit=limit,
                cardData=False,
            )
            results = []
            for m in models:
                results.append({
                    "id":        m.modelId,
                    "downloads": getattr(m, "downloads", 0),
                    "likes":     getattr(m, "likes", 0),
                    "tags":      getattr(m, "tags", [])[:10],
                    "pipeline":  getattr(m, "pipeline_tag", ""),
                })
            return {"models": results, "count": len(results)}

        elif operation == "get_model":
            model_id = inputs.get("model_id", "")
            if not model_id:
                return {"error": "model_id required"}
            info = api.model_info(model_id, cardData=True)
            card = ""
            try:
                from huggingface_hub import ModelCard
                mc   = ModelCard.load(model_id)
                card = str(mc.content)[:2000]
            except Exception:
                pass
            return {
                "id":          info.modelId,
                "downloads":   getattr(info, "downloads", 0),
                "likes":       getattr(info, "likes", 0),
                "tags":        getattr(info, "tags", []),
                "pipeline":    getattr(info, "pipeline_tag", ""),
                "library":     getattr(info, "library_name", ""),
                "created_at":  str(getattr(info, "created_at", "")),
                "card_excerpt": card,
            }

        elif operation == "list_model_files":
            model_id = inputs.get("model_id", "")
            if not model_id:
                return {"error": "model_id required"}
            files = api.list_repo_files(model_id)
            file_list = list(files)
            return {"files": file_list, "count": len(file_list)}

        elif operation == "search_datasets":
            query = inputs.get("query", "")
            task  = inputs.get("task")
            sort  = inputs.get("sort", "downloads")
            datasets = api.list_datasets(
                search=query or None,
                task_categories=task,
                sort=sort,
                limit=limit,
            )
            results = []
            for d in datasets:
                results.append({
                    "id":        d.id,
                    "downloads": getattr(d, "downloads", 0),
                    "likes":     getattr(d, "likes", 0),
                    "tags":      getattr(d, "tags", [])[:8],
                })
            return {"datasets": results, "count": len(results)}

        elif operation == "get_dataset":
            dataset_id = inputs.get("dataset_id", "")
            if not dataset_id:
                return {"error": "dataset_id required"}
            info = api.dataset_info(dataset_id, cardData=True)
            card = ""
            try:
                from huggingface_hub import DatasetCard
                dc   = DatasetCard.load(dataset_id)
                card = str(dc.content)[:1500]
            except Exception:
                pass
            return {
                "id":          info.id,
                "downloads":   getattr(info, "downloads", 0),
                "likes":       getattr(info, "likes", 0),
                "tags":        getattr(info, "tags", []),
                "card_excerpt": card,
            }

        return {"error": f"Unknown operation: {operation}"}

    except Exception as exc:
        logger.error("[huggingface_tool] %s failed: %s", operation, exc)
        return {"error": str(exc)}
