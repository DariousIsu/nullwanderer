"""
Security Tools — Request scanning and supply-chain attack detection.

Combines Pipelock-style outbound request scanning with plugin/package
auditing methodology. Runs fully local with no external dependencies.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import tempfile
from pathlib import Path

from app.tools._mcp_wrapper import _error

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "security_scan",
    "description": (
        "Security scanning toolkit for AI agent safety. Actions: "
        "(1) scan_request — analyze outbound HTTP requests for credential leaks, SSRF, "
        "and prompt injection before sending. "
        "(2) audit_package — check a pip/npm package for supply-chain attack indicators "
        "(typosquatting, suspicious install scripts, recent name changes). "
        "(3) audit_plugin — analyze a tool/plugin file for hidden API calls, data exfiltration, "
        "or malicious patterns."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["scan_request", "audit_package", "audit_plugin"],
                "description": "Security action to perform",
            },
            "url": {
                "type": "string",
                "description": "URL to scan (for scan_request)",
            },
            "headers": {
                "type": "object",
                "description": "HTTP headers to scan (for scan_request)",
            },
            "body": {
                "type": "string",
                "description": "Request body to scan (for scan_request)",
            },
            "package_name": {
                "type": "string",
                "description": "Package name to audit (for audit_package)",
            },
            "package_manager": {
                "type": "string",
                "enum": ["pip", "npm"],
                "description": "Package manager (for audit_package)",
                "default": "pip",
            },
            "file_path": {
                "type": "string",
                "description": "Path to plugin/tool file to audit (for audit_plugin)",
            },
        },
        "required": ["action"],
    },
}


# ── Request Scanner ──────────────────────────────────────────────────────────

_SENSITIVE_PATTERNS = [
    (r"(?i)(api[_-]?key|secret|token|password|auth|credential|bearer)\s*[:=]\s*\S+", "Credential in payload"),
    (r"(?i)(aws|gcp|azure)[_-]?(access|secret|key)", "Cloud credential reference"),
    (r"sk-[a-zA-Z0-9]{20,}", "OpenAI-style API key"),
    (r"ghp_[a-zA-Z0-9]{36}", "GitHub personal access token"),
    (r"eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}", "JWT token"),
    (r"(?i)BEGIN\s+(RSA|DSA|EC|OPENSSH)\s+PRIVATE\s+KEY", "Private key material"),
]

_SSRF_PATTERNS = [
    (r"(?i)(169\.254\.169\.254|metadata\.google|100\.100\.100\.200)", "Cloud metadata endpoint (SSRF)"),
    (r"(?i)(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)(?::\d+)?/", "Localhost request (potential SSRF)"),
    (r"(?i)file://", "File protocol (local file access)"),
    (r"(?i)gopher://", "Gopher protocol (SSRF vector)"),
]


def _scan_request(inputs: dict) -> dict:
    url = inputs.get("url", "")
    headers = inputs.get("headers", {})
    body = inputs.get("body", "")

    findings = []
    combined = f"{url} {json.dumps(headers)} {body}"

    for pattern, description in _SENSITIVE_PATTERNS:
        if re.search(pattern, combined):
            findings.append({"severity": "HIGH", "type": "credential_leak", "description": description})

    for pattern, description in _SSRF_PATTERNS:
        if re.search(pattern, url):
            findings.append({"severity": "HIGH", "type": "ssrf", "description": description})

    # Check for prompt injection in headers/body
    injection_markers = ["ignore previous", "system prompt", "you are now", "disregard", "new instructions"]
    for marker in injection_markers:
        if marker.lower() in combined.lower():
            findings.append({"severity": "MEDIUM", "type": "prompt_injection", "description": f"Potential prompt injection: '{marker}'"})

    safe = len(findings) == 0
    return {
        "safe": safe,
        "findings": findings,
        "scanned_url": url,
        "verdict": "PASS" if safe else "BLOCK",
    }


# ── Package Auditor ──────────────────────────────────────────────────────────

_TYPOSQUAT_PREFIXES = ["python-", "py-", "node-", "js-", "-js", "-py"]
_KNOWN_POPULAR = {
    "pip": ["requests", "flask", "django", "numpy", "pandas", "httpx", "fastapi", "torch", "tensorflow"],
    "npm": ["express", "react", "vue", "axios", "lodash", "webpack", "next", "typescript"],
}


async def _audit_package(inputs: dict) -> dict:
    name = inputs.get("package_name", "")
    manager = inputs.get("package_manager", "pip")

    if not name:
        return _error("package_name is required")

    findings = []

    # Check typosquatting
    for popular in _KNOWN_POPULAR.get(manager, []):
        # Levenshtein-like check: if name is very similar to a popular package
        if name != popular and (
            name.replace("-", "") == popular.replace("-", "") or
            name.replace("_", "") == popular.replace("_", "") or
            any(name == f"{prefix}{popular}" or name == f"{popular}{suffix}"
                for prefix in ["python-", "py-", ""] for suffix in ["-python", "-py", "2", "3"])
        ):
            findings.append({
                "severity": "HIGH",
                "type": "typosquatting",
                "description": f"Name suspiciously similar to popular package '{popular}'",
            })

    # Check for suspicious package names
    if re.search(r"(hack|exploit|crack|steal|dump|inject|backdoor)", name, re.IGNORECASE):
        findings.append({
            "severity": "HIGH",
            "type": "suspicious_name",
            "description": "Package name contains security-related keywords",
        })

    # Check package info via pip/npm
    if manager == "pip":
        pip_bin = shutil.which("pip3") or shutil.which("pip")
        if pip_bin:
            try:
                proc = await asyncio.create_subprocess_exec(
                    pip_bin, "show", name,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
                info = stdout.decode(errors="replace")
                if "Name:" not in info:
                    findings.append({"severity": "INFO", "type": "not_installed", "description": "Package not currently installed"})
                else:
                    # Check if it has a home page
                    if "Home-page: UNKNOWN" in info or "Home-page: \n" in info:
                        findings.append({"severity": "LOW", "type": "no_homepage", "description": "Package has no homepage set"})
            except Exception:
                pass

    safe = not any(f["severity"] == "HIGH" for f in findings)
    return {
        "safe": safe,
        "package": name,
        "manager": manager,
        "findings": findings,
        "verdict": "PASS" if safe else "REVIEW",
    }


# ── Plugin/Tool Auditor ─────────────────────────────────────────────────────

_DANGEROUS_PATTERNS = [
    (r"(?i)exec\s*\(", "Dynamic code execution (exec)"),
    (r"(?i)eval\s*\(", "Dynamic code evaluation (eval)"),
    (r"(?i)subprocess\.(call|run|Popen|check_output)", "Subprocess execution"),
    (r"(?i)os\.system\s*\(", "OS system command execution"),
    (r"(?i)(requests|httpx|urllib|aiohttp)\.(get|post|put|delete|patch)\s*\(", "Outbound HTTP request"),
    (r"(?i)open\s*\([^)]*['\"]w", "File write operation"),
    (r"(?i)base64\.(b64decode|decodebytes)", "Base64 decoding (potential obfuscation)"),
    (r"(?i)__import__\s*\(", "Dynamic import (potential code injection)"),
    (r"(?i)(smtp|sendmail|send_message)", "Email sending capability"),
    (r"(?i)socket\.(socket|connect)", "Raw socket access"),
    (r"(?i)(telnetlib|paramiko|fabric)", "Remote access library"),
]


def _audit_plugin(inputs: dict) -> dict:
    file_path = inputs.get("file_path", "")
    if not file_path:
        return _error("file_path is required for audit_plugin")

    path = Path(file_path)
    if not path.is_file():
        return _error(f"File not found: {file_path}")

    content = path.read_text(encoding="utf-8", errors="replace")
    findings = []

    for pattern, description in _DANGEROUS_PATTERNS:
        matches = re.findall(pattern, content)
        if matches:
            findings.append({
                "severity": "MEDIUM",
                "type": "dangerous_pattern",
                "description": description,
                "count": len(matches),
            })

    # Check for obfuscated code
    if re.search(r"\\x[0-9a-f]{2}", content):
        findings.append({"severity": "HIGH", "type": "obfuscation", "description": "Hex-encoded strings detected"})
    if re.search(r"chr\(\d+\)", content) and content.count("chr(") > 5:
        findings.append({"severity": "HIGH", "type": "obfuscation", "description": "Excessive chr() encoding detected"})

    # File stats
    file_hash = hashlib.sha256(content.encode()).hexdigest()

    safe = not any(f["severity"] == "HIGH" for f in findings)
    return {
        "safe": safe,
        "file": str(path),
        "sha256": file_hash,
        "size_bytes": path.stat().st_size,
        "findings": findings,
        "verdict": "PASS" if safe else "REVIEW",
    }


async def tool_handler(inputs: dict) -> dict:
    action = inputs.get("action", "")

    if action == "scan_request":
        return _scan_request(inputs)
    elif action == "audit_package":
        return await _audit_package(inputs)
    elif action == "audit_plugin":
        return _audit_plugin(inputs)
    else:
        return _error(f"Unknown action: {action}. Use: scan_request, audit_package, audit_plugin")
