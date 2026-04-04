"""
OCR Tool — Extract text from images and scanned documents.

Uses OpenOCR (0.1B param model, Apache 2.0) as primary engine with
pytesseract as lightweight fallback. Runs fully local, no API keys.
"""

from __future__ import annotations

import base64
import logging
import os
import tempfile
from pathlib import Path

from app.tools._mcp_wrapper import _error

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "ocr",
    "description": (
        "Extract text from images and scanned documents. Supports PNG, JPG, "
        "PDF screenshots, and scanned pages. Uses a local 0.1B parameter model "
        "for high-accuracy OCR including formulas, tables, and multilingual text. "
        "Falls back to Tesseract if the primary engine is unavailable."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "image_path": {
                "type": "string",
                "description": "Absolute path to the image or scanned document file",
            },
            "image_base64": {
                "type": "string",
                "description": "Base64-encoded image data (alternative to image_path)",
            },
            "engine": {
                "type": "string",
                "enum": ["auto", "openocr", "tesseract"],
                "description": "OCR engine to use (default: auto — tries OpenOCR first, then Tesseract)",
                "default": "auto",
            },
            "language": {
                "type": "string",
                "description": "Language hint for Tesseract (e.g. 'eng', 'chi_sim'). Ignored by OpenOCR.",
                "default": "eng",
            },
        },
        "required": [],
    },
}


def _resolve_image(inputs: dict) -> str | None:
    """Return a file path to the image, decoding base64 if necessary."""
    path = inputs.get("image_path", "")
    if path and Path(path).is_file():
        return str(Path(path).resolve())

    b64 = inputs.get("image_base64", "")
    if b64:
        try:
            data = base64.b64decode(b64)
            tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
            tmp.write(data)
            tmp.close()
            return tmp.name
        except Exception as exc:
            logger.error("[ocr] base64 decode failed: %s", exc)
    return None


async def _ocr_openocr(image_path: str) -> dict:
    """Run OCR via openocr-python library."""
    try:
        from openocr import OpenOCR
    except ImportError:
        return _error("openocr-python not installed. Run: pip install openocr-python")

    try:
        engine = OpenOCR()
        result = engine(image_path)
        text = result if isinstance(result, str) else str(result)
        return {"text": text.strip(), "engine": "openocr", "path": image_path}
    except Exception as exc:
        logger.error("[ocr:openocr] %s", exc)
        return _error(f"OpenOCR failed: {exc}")


async def _ocr_tesseract(image_path: str, language: str = "eng") -> dict:
    """Run OCR via pytesseract + Tesseract binary."""
    try:
        import pytesseract
        from PIL import Image
    except ImportError:
        return _error(
            "pytesseract or Pillow not installed. Run: "
            "pip install pytesseract Pillow && apt install tesseract-ocr"
        )

    try:
        img = Image.open(image_path)
        text = pytesseract.image_to_string(img, lang=language)
        return {"text": text.strip(), "engine": "tesseract", "language": language, "path": image_path}
    except Exception as exc:
        logger.error("[ocr:tesseract] %s", exc)
        return _error(f"Tesseract failed: {exc}")


async def tool_handler(inputs: dict) -> dict:
    image_path = _resolve_image(inputs)
    if not image_path:
        return _error("Provide either image_path (file path) or image_base64 (base64 data)")

    engine = inputs.get("engine", "auto")
    language = inputs.get("language", "eng")

    if engine == "openocr":
        return await _ocr_openocr(image_path)
    elif engine == "tesseract":
        return await _ocr_tesseract(image_path, language)
    else:  # auto
        result = await _ocr_openocr(image_path)
        if "error" not in result:
            return result
        logger.info("[ocr] OpenOCR unavailable, falling back to Tesseract")
        return await _ocr_tesseract(image_path, language)
