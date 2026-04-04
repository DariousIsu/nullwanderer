"""
Code Runner — Execute and test code in multiple languages.

Sandboxed subprocess execution for Python, Rust, Go, Java, JavaScript/Node,
and shell scripts. Runs fully local using system-installed compilers/interpreters.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
from pathlib import Path

from app.tools._mcp_wrapper import _error

logger = logging.getLogger(__name__)

_TIMEOUT_SECONDS = 30

TOOL_DEF = {
    "name": "code_runner",
    "description": (
        "Execute code snippets in multiple programming languages and return the output. "
        "Supports Python, Rust, Go, Java, JavaScript (Node.js), TypeScript, and shell scripts. "
        "Code runs in a temporary directory with a timeout. Use for testing, prototyping, "
        "or running computations."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "language": {
                "type": "string",
                "enum": ["python", "rust", "go", "java", "javascript", "typescript", "bash"],
                "description": "Programming language of the code",
            },
            "code": {
                "type": "string",
                "description": "Source code to execute",
            },
            "stdin": {
                "type": "string",
                "description": "Standard input to provide to the program",
                "default": "",
            },
            "timeout": {
                "type": "integer",
                "description": "Execution timeout in seconds (default: 30, max: 120)",
                "default": 30,
            },
            "args": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Command-line arguments to pass to the program",
            },
        },
        "required": ["language", "code"],
    },
}


async def _run_subprocess(cmd: list[str], cwd: str, stdin_data: str = "", timeout: int = _TIMEOUT_SECONDS) -> dict:
    """Execute a subprocess and capture output."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.PIPE if stdin_data else None,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(input=stdin_data.encode() if stdin_data else None),
            timeout=timeout,
        )
        return {
            "exit_code": proc.returncode,
            "stdout": stdout.decode(errors="replace")[:10000],
            "stderr": stderr.decode(errors="replace")[:5000],
        }
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        return {"exit_code": -1, "stdout": "", "stderr": f"Execution timed out after {timeout} seconds"}
    except Exception as exc:
        return {"exit_code": -1, "stdout": "", "stderr": str(exc)}


async def _run_python(code: str, stdin_data: str, timeout: int, args: list[str], cwd: str) -> dict:
    src = Path(cwd) / "main.py"
    src.write_text(code, encoding="utf-8")
    python = shutil.which("python3") or shutil.which("python") or "python"
    return await _run_subprocess([python, str(src)] + args, cwd, stdin_data, timeout)


async def _run_rust(code: str, stdin_data: str, timeout: int, args: list[str], cwd: str) -> dict:
    rustc = shutil.which("rustc")
    if not rustc:
        return _error("rustc not found. Install Rust: https://rustup.rs/")
    src = Path(cwd) / "main.rs"
    out = Path(cwd) / "main"
    src.write_text(code, encoding="utf-8")
    compile_result = await _run_subprocess([rustc, str(src), "-o", str(out)], cwd, timeout=timeout)
    if compile_result.get("exit_code", -1) != 0:
        compile_result["phase"] = "compilation"
        return compile_result
    run_result = await _run_subprocess([str(out)] + args, cwd, stdin_data, timeout)
    run_result["phase"] = "execution"
    return run_result


async def _run_go(code: str, stdin_data: str, timeout: int, args: list[str], cwd: str) -> dict:
    go_bin = shutil.which("go")
    if not go_bin:
        return _error("go not found. Install Go: https://go.dev/dl/")
    src = Path(cwd) / "main.go"
    src.write_text(code, encoding="utf-8")
    return await _run_subprocess([go_bin, "run", str(src)] + args, cwd, stdin_data, timeout)


async def _run_java(code: str, stdin_data: str, timeout: int, args: list[str], cwd: str) -> dict:
    javac = shutil.which("javac")
    java = shutil.which("java")
    if not javac or not java:
        return _error("javac/java not found. Install JDK: apt install default-jdk")

    # Extract class name from code
    import re
    match = re.search(r"public\s+class\s+(\w+)", code)
    class_name = match.group(1) if match else "Main"
    src = Path(cwd) / f"{class_name}.java"
    src.write_text(code, encoding="utf-8")

    compile_result = await _run_subprocess([javac, str(src)], cwd, timeout=timeout)
    if compile_result.get("exit_code", -1) != 0:
        compile_result["phase"] = "compilation"
        return compile_result
    run_result = await _run_subprocess([java, "-cp", cwd, class_name] + args, cwd, stdin_data, timeout)
    run_result["phase"] = "execution"
    return run_result


async def _run_javascript(code: str, stdin_data: str, timeout: int, args: list[str], cwd: str) -> dict:
    node = shutil.which("node")
    if not node:
        return _error("node not found. Install Node.js: https://nodejs.org/")
    src = Path(cwd) / "main.js"
    src.write_text(code, encoding="utf-8")
    return await _run_subprocess([node, str(src)] + args, cwd, stdin_data, timeout)


async def _run_typescript(code: str, stdin_data: str, timeout: int, args: list[str], cwd: str) -> dict:
    npx = shutil.which("npx")
    tsx = shutil.which("tsx")
    if tsx:
        src = Path(cwd) / "main.ts"
        src.write_text(code, encoding="utf-8")
        return await _run_subprocess([tsx, str(src)] + args, cwd, stdin_data, timeout)
    elif npx:
        src = Path(cwd) / "main.ts"
        src.write_text(code, encoding="utf-8")
        return await _run_subprocess([npx, "tsx", str(src)] + args, cwd, stdin_data, timeout)
    return _error("tsx/npx not found. Install: npm install -g tsx")


async def _run_bash(code: str, stdin_data: str, timeout: int, args: list[str], cwd: str) -> dict:
    bash = shutil.which("bash") or shutil.which("sh")
    if not bash:
        return _error("bash/sh not found")
    src = Path(cwd) / "script.sh"
    src.write_text(code, encoding="utf-8")
    os.chmod(str(src), 0o755)
    return await _run_subprocess([bash, str(src)] + args, cwd, stdin_data, timeout)


_RUNNERS = {
    "python": _run_python,
    "rust": _run_rust,
    "go": _run_go,
    "java": _run_java,
    "javascript": _run_javascript,
    "typescript": _run_typescript,
    "bash": _run_bash,
}


async def tool_handler(inputs: dict) -> dict:
    language = inputs.get("language", "")
    code = inputs.get("code", "")
    if not language:
        return _error("language is required")
    if not code:
        return _error("code is required")

    runner = _RUNNERS.get(language)
    if not runner:
        return _error(f"Unsupported language: {language}. Supported: {list(_RUNNERS.keys())}")

    timeout = min(inputs.get("timeout", _TIMEOUT_SECONDS), 120)
    stdin_data = inputs.get("stdin", "")
    args = inputs.get("args", [])

    cwd = tempfile.mkdtemp(prefix="aura_code_")
    try:
        result = await runner(code, stdin_data, timeout, args, cwd)
        if isinstance(result, dict):
            result["language"] = language
        return result
    except Exception as exc:
        logger.error("[code_runner] %s", exc)
        return _error(str(exc))
    finally:
        # Clean up temp directory
        import shutil as _shutil
        try:
            _shutil.rmtree(cwd, ignore_errors=True)
        except Exception:
            pass
