"""
Chart Image Tool — Generate publication-quality charts from data.

Uses matplotlib and plotly for local chart rendering. No API keys required.
Outputs PNG/SVG/HTML files suitable for canvas image blocks.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path

from app.tools._mcp_wrapper import _error

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "chart_image",
    "description": (
        "Generate publication-quality chart images from data. Supports bar, line, "
        "scatter, pie, histogram, heatmap, and area charts. Provide data as JSON "
        "arrays and get back a rendered PNG, SVG, or interactive HTML file. "
        "Works fully offline with no API keys."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "chart_type": {
                "type": "string",
                "enum": ["bar", "line", "scatter", "pie", "histogram", "heatmap", "area", "candlestick"],
                "description": "Type of chart to generate",
            },
            "data": {
                "type": "object",
                "description": (
                    "Chart data. For most charts: {labels: [...], values: [...]} or "
                    "{x: [...], y: [...]}. For multi-series: {labels: [...], series: [{name: str, values: [...]}]}. "
                    "For candlestick: {dates: [...], open: [...], high: [...], low: [...], close: [...]}."
                ),
            },
            "title": {
                "type": "string",
                "description": "Chart title",
                "default": "",
            },
            "x_label": {
                "type": "string",
                "description": "X-axis label",
                "default": "",
            },
            "y_label": {
                "type": "string",
                "description": "Y-axis label",
                "default": "",
            },
            "output_format": {
                "type": "string",
                "enum": ["png", "svg", "html"],
                "description": "Output format (default: png)",
                "default": "png",
            },
            "output_path": {
                "type": "string",
                "description": "Absolute path for the output file (auto-generated if omitted)",
            },
            "width": {
                "type": "integer",
                "description": "Chart width in pixels (default: 800)",
                "default": 800,
            },
            "height": {
                "type": "integer",
                "description": "Chart height in pixels (default: 500)",
                "default": 500,
            },
            "theme": {
                "type": "string",
                "enum": ["default", "dark", "minimal"],
                "description": "Visual theme (default: default)",
                "default": "default",
            },
        },
        "required": ["chart_type", "data"],
    },
}


def _apply_theme(theme: str):
    """Apply matplotlib theme."""
    import matplotlib.pyplot as plt
    if theme == "dark":
        plt.style.use("dark_background")
    elif theme == "minimal":
        plt.style.use("seaborn-v0_8-whitegrid")
    else:
        plt.style.use("seaborn-v0_8")


def _render_matplotlib(inputs: dict) -> dict:
    """Render chart using matplotlib."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import numpy as np
    except ImportError:
        return _error("matplotlib not installed. Run: pip install matplotlib")

    chart_type = inputs["chart_type"]
    data = inputs["data"]
    title = inputs.get("title", "")
    x_label = inputs.get("x_label", "")
    y_label = inputs.get("y_label", "")
    output_format = inputs.get("output_format", "png")
    width = inputs.get("width", 800)
    height = inputs.get("height", 500)
    theme = inputs.get("theme", "default")

    _apply_theme(theme)
    fig, ax = plt.subplots(figsize=(width / 100, height / 100), dpi=100)

    labels = data.get("labels", data.get("x", []))
    values = data.get("values", data.get("y", []))
    series = data.get("series", [])

    if chart_type == "bar":
        if series:
            x_pos = np.arange(len(labels))
            bar_width = 0.8 / len(series)
            for i, s in enumerate(series):
                ax.bar(x_pos + i * bar_width, s["values"], bar_width, label=s.get("name", f"Series {i+1}"))
            ax.set_xticks(x_pos + bar_width * (len(series) - 1) / 2)
            ax.set_xticklabels(labels, rotation=45, ha="right")
            ax.legend()
        else:
            ax.bar(labels, values)
            plt.xticks(rotation=45, ha="right")

    elif chart_type == "line":
        if series:
            for s in series:
                ax.plot(labels, s["values"], label=s.get("name", ""), marker="o", markersize=3)
            ax.legend()
        else:
            ax.plot(labels, values, marker="o", markersize=3)

    elif chart_type == "scatter":
        x_vals = data.get("x", labels)
        y_vals = data.get("y", values)
        sizes = data.get("sizes", None)
        colors = data.get("colors", None)
        ax.scatter(x_vals, y_vals, s=sizes, c=colors, alpha=0.7)

    elif chart_type == "pie":
        ax.pie(values, labels=labels, autopct="%1.1f%%", startangle=90)
        ax.axis("equal")

    elif chart_type == "histogram":
        bins = data.get("bins", 20)
        ax.hist(values, bins=bins, edgecolor="black", alpha=0.7)

    elif chart_type == "area":
        if series:
            for s in series:
                ax.fill_between(range(len(s["values"])), s["values"], alpha=0.4, label=s.get("name", ""))
            ax.set_xticks(range(len(labels)))
            ax.set_xticklabels(labels, rotation=45, ha="right")
            ax.legend()
        else:
            ax.fill_between(range(len(values)), values, alpha=0.4)
            if labels:
                ax.set_xticks(range(len(labels)))
                ax.set_xticklabels(labels, rotation=45, ha="right")

    elif chart_type == "heatmap":
        matrix = data.get("matrix", [])
        if not matrix:
            return _error("heatmap requires data.matrix (2D array)")
        im = ax.imshow(matrix, cmap="viridis", aspect="auto")
        fig.colorbar(im)
        if labels:
            ax.set_xticks(range(len(labels)))
            ax.set_xticklabels(labels, rotation=45, ha="right")
        row_labels = data.get("row_labels", [])
        if row_labels:
            ax.set_yticks(range(len(row_labels)))
            ax.set_yticklabels(row_labels)

    else:
        return _error(f"Unsupported chart type for matplotlib: {chart_type}")

    if title:
        ax.set_title(title)
    if x_label:
        ax.set_xlabel(x_label)
    if y_label:
        ax.set_ylabel(y_label)

    plt.tight_layout()

    output_path = inputs.get("output_path", "")
    if not output_path:
        output_path = os.path.join(tempfile.gettempdir(), f"aura_chart.{output_format}")

    fig.savefig(output_path, format=output_format if output_format != "html" else "png",
                bbox_inches="tight", dpi=150)
    plt.close(fig)

    return {"output_path": output_path, "format": output_format, "chart_type": chart_type}


def _render_plotly_candlestick(inputs: dict) -> dict:
    """Render candlestick chart using plotly."""
    try:
        import plotly.graph_objects as go
    except ImportError:
        return _error("plotly not installed. Run: pip install plotly")

    data = inputs["data"]
    title = inputs.get("title", "")
    output_format = inputs.get("output_format", "html")
    output_path = inputs.get("output_path", "")

    fig = go.Figure(data=[go.Candlestick(
        x=data.get("dates", []),
        open=data.get("open", []),
        high=data.get("high", []),
        low=data.get("low", []),
        close=data.get("close", []),
    )])

    if title:
        fig.update_layout(title=title)

    if not output_path:
        ext = "html" if output_format == "html" else output_format
        output_path = os.path.join(tempfile.gettempdir(), f"aura_candlestick.{ext}")

    if output_format == "html":
        fig.write_html(output_path)
    else:
        fig.write_image(output_path, width=inputs.get("width", 800), height=inputs.get("height", 500))

    return {"output_path": output_path, "format": output_format, "chart_type": "candlestick"}


async def tool_handler(inputs: dict) -> dict:
    chart_type = inputs.get("chart_type", "")
    if not chart_type:
        return _error("chart_type is required")

    data = inputs.get("data")
    if not data:
        return _error("data is required")

    if chart_type == "candlestick":
        return _render_plotly_candlestick(inputs)

    return _render_matplotlib(inputs)
