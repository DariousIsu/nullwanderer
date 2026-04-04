"""
AURA NX-Alpha — Self-Improvement Service
Allows AURA to propose, apply, and revert corrections to her own codebase.

WHAT IT HANDLES AT LAUNCH:
    Tier 1 — Cosmetic: iterative canvas mockups → apply style changes
    Tier 2 — Correction: read files → plan → propose diff → validate → apply

POST-LAUNCH (Sprint 1):
    External GitHub repo intake, scoring, and Tier 3 new features.

FLOW:
    1. propose(description, file_paths)
         → reads files, calls change_planner, returns job_id + diff summary
    2. apply(job_id)
         → create branch → write changes → validate → test → merge → emit SSE
    3. revert(job_id | "last")
         → git revert → emit SSE

SINGLETON PATTERN:
    init_self_improvement_service() called once at startup.
    get_self_improvement_service() used by tools and controller.

PERSISTENCE:
    ~/.aura/improvements/registry.json — job history, survives restarts.

SSE EVENTS:
    improvement_update — progress during apply/revert
    improvement_complete — job finished (success or failure)
    canvas_preview — cosmetic mockup for user review
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Literal, Optional

logger = logging.getLogger(__name__)

_IMPROVEMENTS_DIR = Path.home() / ".aura" / "improvements"
_REGISTRY_FILE    = _IMPROVEMENTS_DIR / "registry.json"

JobStatus = Literal[
    "pending",        # plan generated, awaiting user approval
    "applying",       # branch created, writing + validating
    "applied",        # merged to main, live
    "reverting",      # revert in progress
    "reverted",       # revert committed
    "failed",         # apply or validation failed
]


# ─────────────────────────────────────────────────────────────────────────────
# DATA MODEL
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class ImprovementJob:
    job_id:       str
    description:  str
    tier:         str                    # "cosmetic" | "correction"
    status:       JobStatus = "pending"
    plan:         Optional[dict] = None  # change_planner output
    diff:         Optional[str] = None   # unified diff after apply
    branch:       Optional[str] = None
    commit_hash:  Optional[str] = None   # hash after merge (used for revert)
    error:        Optional[str] = None
    created_at:   str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    applied_at:   Optional[str] = None
    reverted_at:  Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_instance: Optional["SelfImprovementService"] = None


# ─────────────────────────────────────────────────────────────────────────────
# SERVICE
# ─────────────────────────────────────────────────────────────────────────────

class SelfImprovementService:

    def __init__(self) -> None:
        self._jobs: Dict[str, ImprovementJob] = {}
        _IMPROVEMENTS_DIR.mkdir(parents=True, exist_ok=True)
        self._load_registry()

    # ──────────────────────────────────────────────────────────────────────────
    # Public API — called by interface_agent tool dispatch
    # ──────────────────────────────────────────────────────────────────────────

    async def read_file(self, rel_path: str) -> str:
        """
        Read a project file for analysis.
        Called by Aura before proposing a change.
        """
        from app.tools.git_tool import read_file
        try:
            content = read_file(rel_path)
            logger.info("[self_improve] Read file: %s (%d chars)", rel_path, len(content))
            return content
        except Exception as exc:
            return f"Error reading {rel_path}: {exc}"

    async def propose(
        self,
        description: str,
        file_paths: List[str],
        tier: str = "correction",
    ) -> Dict:
        """
        Read the given files, call the change planner, and store a pending job.

        Returns:
            {job_id, tier, summary, diff_preview, risk, files_changed}
        """
        from app.tools.git_tool import read_file as git_read
        from app.service.change_planner import plan_correction

        # Read all relevant files
        file_contents: dict[str, str] = {}
        for path in file_paths:
            try:
                file_contents[path] = git_read(path)
            except Exception as exc:
                logger.warning("[self_improve] Could not read %s: %s", path, exc)

        if not file_contents:
            return {"error": "Could not read any of the specified files."}

        plan = await plan_correction(description, file_contents, tier)
        if "error" in plan and not plan.get("changes"):
            return {"error": plan["error"]}

        job_id = uuid.uuid4().hex[:8]
        job = ImprovementJob(
            job_id=job_id,
            description=description,
            tier=plan.get("tier", tier),
            plan=plan,
        )
        self._jobs[job_id] = job
        self._save_registry()

        # Build a human-readable diff preview
        diff_preview = self._format_plan_preview(plan)

        return {
            "job_id":        job_id,
            "tier":          job.tier,
            "summary":       plan.get("summary", description),
            "diff_preview":  diff_preview,
            "risk":          plan.get("risk", "low"),
            "files_changed": [c["path"] for c in plan.get("changes", [])],
        }

    async def apply(self, job_id: str) -> Dict:
        """
        Apply a pending job:
            create branch → write changes → validate → test → merge → cleanup.

        Returns status dict. Detailed progress emitted via SSE.
        """
        job = self._get_job(job_id)
        if job.status != "pending":
            return {"error": f"Job {job_id} is not pending (status: {job.status})"}

        asyncio.create_task(self._run_apply(job_id))
        return {"status": "applying", "job_id": job_id}

    async def revert(self, identifier: str) -> Dict:
        """
        Revert a previously applied job.
        identifier: job_id, "last", or a free-text description (fuzzy matched).

        Returns status dict.
        """
        job = self._resolve_identifier(identifier)
        if job is None:
            return {"error": f"No applied improvement matching: {identifier!r}"}
        if job.status not in ("applied",):
            return {"error": f"Job {job.job_id} cannot be reverted (status: {job.status})"}
        if not job.commit_hash:
            return {"error": f"Job {job.job_id} has no commit hash recorded — cannot revert automatically."}

        asyncio.create_task(self._run_revert(job.job_id))
        return {"status": "reverting", "job_id": job.job_id}

    async def cosmetic_mockup(self, description: str, rel_path: Optional[str] = None) -> Dict:
        """
        Generate a canvas preview mockup without touching any files.
        Called during the iterative cosmetic design loop.
        """
        from app.service.change_planner import plan_cosmetic_mockup
        from app.tools.git_tool import read_file as git_read

        current = ""
        if rel_path:
            try:
                current = git_read(rel_path)[:3000]
            except Exception:
                pass

        result = await plan_cosmetic_mockup(description, current)

        # Emit to canvas
        await self._emit_sse("canvas_preview", {
            "html":        result.get("mockup_html", ""),
            "description": result.get("description", description),
        })

        return result

    def get_job(self, job_id: str) -> Optional[Dict]:
        job = self._jobs.get(job_id)
        return asdict(job) if job else None

    def list_jobs(self, limit: int = 20) -> List[Dict]:
        sorted_jobs = sorted(
            self._jobs.values(),
            key=lambda j: j.created_at,
            reverse=True,
        )
        return [asdict(j) for j in sorted_jobs[:limit]]

    # ──────────────────────────────────────────────────────────────────────────
    # Apply pipeline
    # ──────────────────────────────────────────────────────────────────────────

    async def _run_apply(self, job_id: str) -> None:
        from app.tools import git_tool

        job = self._get_job(job_id)
        job.status = "applying"
        self._save_registry()

        slug  = re.sub(r"[^a-z0-9]+", "-", job.description.lower())[:30].strip("-")
        slug  = f"{slug}-{job_id}"

        try:
            # ── 1. Create branch ──────────────────────────────────────────────
            await self._emit_sse("improvement_update", {
                "job_id": job_id, "step": "branch", "message": f"Creating branch {slug}..."
            })
            base_branch = git_tool.current_branch()
            branch = git_tool.create_branch(slug)
            job.branch = branch

            # ── 2. Apply file changes ─────────────────────────────────────────
            changes = job.plan.get("changes", [])
            for i, change in enumerate(changes):
                path    = change["path"]
                op      = change.get("operation", "modify")
                await self._emit_sse("improvement_update", {
                    "job_id":  job_id,
                    "step":    "write",
                    "message": f"Writing {path} ({i + 1}/{len(changes)})...",
                })

                if op == "create":
                    git_tool.write_file(path, change["new_snippet"])
                else:
                    current = git_tool.read_file(path)
                    old = change.get("old_snippet", "")
                    new = change.get("new_snippet", "")
                    if old and old not in current:
                        raise ValueError(
                            f"old_snippet not found verbatim in {path}. "
                            "The file may have changed since the plan was generated."
                        )
                    updated = current.replace(old, new, 1) if old else new
                    git_tool.write_file(path, updated)

            # ── 3. Commit ─────────────────────────────────────────────────────
            await self._emit_sse("improvement_update", {
                "job_id": job_id, "step": "commit", "message": "Committing changes..."
            })
            git_tool.commit_all(f"AURA self-improvement [{job_id}]: {job.description[:60]}")

            # ── 4. Validate syntax ────────────────────────────────────────────
            await self._emit_sse("improvement_update", {
                "job_id": job_id, "step": "validate", "message": "Validating syntax..."
            })
            for change in changes:
                path = change["path"]
                if path.endswith(".py"):
                    ok, err = git_tool.validate_python(path)
                    if not ok:
                        raise ValueError(f"Syntax error in {path}: {err}")

            # ── 5. Run tests (skip for cosmetic) ──────────────────────────────
            if job.tier != "cosmetic":
                test_scope = job.plan.get("test_scope")
                await self._emit_sse("improvement_update", {
                    "job_id": job_id, "step": "test",
                    "message": f"Running tests{f' ({test_scope})' if test_scope else ''}...",
                })
                passed, output = git_tool.run_tests(scope=test_scope)
                if not passed:
                    raise ValueError(f"Tests failed:\n{output}")

            # ── 6. Capture diff before merge ──────────────────────────────────
            job.diff = git_tool.get_diff(branch, base_branch)

            # ── 7. Merge ──────────────────────────────────────────────────────
            await self._emit_sse("improvement_update", {
                "job_id": job_id, "step": "merge", "message": f"Merging into {base_branch}..."
            })
            commit_hash = git_tool.merge_branch(branch, base=base_branch)
            job.commit_hash = commit_hash

            # ── 8. Cleanup branch ─────────────────────────────────────────────
            try:
                git_tool.delete_branch(branch)
            except Exception:
                pass  # non-critical

            job.status     = "applied"
            job.applied_at = datetime.now(timezone.utc).isoformat()
            self._save_registry()

            await self._emit_sse("improvement_complete", {
                "job_id":      job_id,
                "status":      "applied",
                "summary":     job.plan.get("summary", job.description),
                "commit_hash": commit_hash,
                "diff":        job.diff,
            })
            logger.info("[self_improve] Applied job %s → %s", job_id, commit_hash)

        except Exception as exc:
            logger.exception("[self_improve] Apply failed for %s: %s", job_id, exc)
            job.status = "failed"
            job.error  = str(exc)
            self._save_registry()

            # Try to get back to base branch cleanly
            try:
                git_tool.checkout_branch(base_branch)
            except Exception:
                pass

            await self._emit_sse("improvement_complete", {
                "job_id":  job_id,
                "status":  "failed",
                "error":   str(exc),
            })

    # ──────────────────────────────────────────────────────────────────────────
    # Revert pipeline
    # ──────────────────────────────────────────────────────────────────────────

    async def _run_revert(self, job_id: str) -> None:
        from app.tools import git_tool

        job = self._get_job(job_id)
        job.status = "reverting"
        self._save_registry()

        try:
            await self._emit_sse("improvement_update", {
                "job_id": job_id, "step": "revert",
                "message": f"Reverting commit {job.commit_hash[:8]}..."
            })

            new_hash = git_tool.revert_commit(job.commit_hash)

            job.status      = "reverted"
            job.reverted_at = datetime.now(timezone.utc).isoformat()
            self._save_registry()

            await self._emit_sse("improvement_complete", {
                "job_id":      job_id,
                "status":      "reverted",
                "summary":     f"Reverted: {job.plan.get('summary', job.description)}",
                "commit_hash": new_hash,
            })
            logger.info("[self_improve] Reverted job %s → %s", job_id, new_hash)

        except Exception as exc:
            logger.exception("[self_improve] Revert failed for %s: %s", job_id, exc)
            job.status = "failed"
            job.error  = f"Revert failed: {exc}"
            self._save_registry()

            await self._emit_sse("improvement_complete", {
                "job_id": job_id,
                "status": "failed",
                "error":  str(exc),
            })

    # ──────────────────────────────────────────────────────────────────────────
    # Helpers
    # ──────────────────────────────────────────────────────────────────────────

    def _get_job(self, job_id: str) -> ImprovementJob:
        if job_id not in self._jobs:
            raise KeyError(f"Unknown job_id: {job_id!r}")
        return self._jobs[job_id]

    def _resolve_identifier(self, identifier: str) -> Optional[ImprovementJob]:
        """Resolve 'last', a job_id, or a fuzzy description to an applied job."""
        applied = [j for j in self._jobs.values() if j.status == "applied"]
        if not applied:
            return None

        if identifier == "last":
            return max(applied, key=lambda j: j.applied_at or "")

        # Exact job_id
        if identifier in self._jobs:
            j = self._jobs[identifier]
            return j if j.status == "applied" else None

        # Fuzzy match on description or summary
        identifier_lower = identifier.lower()
        for job in sorted(applied, key=lambda j: j.applied_at or "", reverse=True):
            if identifier_lower in job.description.lower():
                return job
            summary = (job.plan or {}).get("summary", "")
            if identifier_lower in summary.lower():
                return job

        return None

    def _format_plan_preview(self, plan: dict) -> str:
        """Format plan changes as a compact human-readable diff preview."""
        lines = [f"Summary: {plan.get('summary', '')}",
                 f"Risk: {plan.get('risk', 'low')}",
                 ""]
        for change in plan.get("changes", []):
            lines.append(f"  {change.get('operation', 'modify').upper()}  {change['path']}")
            lines.append(f"  ↳ {change.get('explanation', '')}")
            old = change.get("old_snippet", "")
            new = change.get("new_snippet", "")
            if old:
                for l in old.splitlines()[:3]:
                    lines.append(f"  - {l}")
            if new:
                for l in new.splitlines()[:3]:
                    lines.append(f"  + {l}")
            lines.append("")
        return "\n".join(lines)

    # ──────────────────────────────────────────────────────────────────────────
    # Persistence
    # ──────────────────────────────────────────────────────────────────────────

    def _save_registry(self) -> None:
        try:
            data = {jid: asdict(j) for jid, j in self._jobs.items()}
            _REGISTRY_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except Exception as exc:
            logger.warning("[self_improve] Failed to save registry: %s", exc)

    def _load_registry(self) -> None:
        if not _REGISTRY_FILE.exists():
            return
        try:
            data = json.loads(_REGISTRY_FILE.read_text(encoding="utf-8"))
            for jid, raw in data.items():
                self._jobs[jid] = ImprovementJob(
                    job_id      = raw["job_id"],
                    description = raw["description"],
                    tier        = raw["tier"],
                    status      = raw.get("status", "pending"),
                    plan        = raw.get("plan"),
                    diff        = raw.get("diff"),
                    branch      = raw.get("branch"),
                    commit_hash = raw.get("commit_hash"),
                    error       = raw.get("error"),
                    created_at  = raw.get("created_at", ""),
                    applied_at  = raw.get("applied_at"),
                    reverted_at = raw.get("reverted_at"),
                )
            logger.info("[self_improve] Loaded %d jobs from registry", len(data))
        except Exception as exc:
            logger.warning("[self_improve] Failed to load registry: %s", exc)

    # ──────────────────────────────────────────────────────────────────────────
    # SSE
    # ──────────────────────────────────────────────────────────────────────────

    @staticmethod
    async def _emit_sse(event_type: str, data: dict) -> None:
        try:
            from app.controller.chat_controller import _emit
            await _emit(event_type, data)
        except Exception as exc:
            logger.debug("[self_improve] SSE emit failed (%s): %s", event_type, exc)


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON LIFECYCLE
# ─────────────────────────────────────────────────────────────────────────────

def init_self_improvement_service() -> SelfImprovementService:
    global _instance
    _instance = SelfImprovementService()
    logger.info("[self_improve] SelfImprovementService initialized")
    return _instance


def get_self_improvement_service() -> Optional[SelfImprovementService]:
    return _instance
