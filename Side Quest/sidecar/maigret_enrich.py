#!/usr/bin/env python3
"""Maigret enrichment SIDECAR (SPIKE) — username -> discovered social/web accounts.

Mirrors the forecasting sidecar contract: read a job JSON (stdin or --job FILE), write a results JSON
(stdout or --out FILE). CONSUME-ONLY: this only READS public site presence for usernames handed to it;
it writes nothing to the Puller or CRM. The Node caller (lib/enrich_maigret.js) decides what, if anything,
to persist — and per the Puller certainty model, discovered accounts land as LOW-GRADE observations to be
verified before promotion (a shared username is not proof of the same person).

Contract:
  job  = { "usernames": ["soxoj", ...], "top_sites": 30, "timeout": 8 }
  out  = { "ok": true, "count": N, "results": [ {"username": u, "accounts": [ {"site","url","tags","ids"} ] } ] }

Run: PYTHONUTF8=1 sidecar/maigret_venv/Scripts/python.exe sidecar/maigret_enrich.py --job job.json --out out.json
(PYTHONUTF8=1 is REQUIRED on Windows — maigret prints a unicode heart in its banner that crashes cp1252.)
"""
import sys
import os
import json
import asyncio
import argparse
import logging

import maigret
from maigret.result import MaigretCheckStatus


def _load_db():
    """Load maigret's site DB from its cached path (auto-downloaded on first CLI run), else bundled."""
    db = maigret.MaigretDatabase()
    cached = os.path.join(os.path.expanduser("~"), ".maigret", "data.json")
    if os.path.exists(cached):
        return db.load_from_path(cached)
    # bundled resource fallback
    bundled = os.path.join(os.path.dirname(maigret.__file__), "resources", "data.json")
    return db.load_from_path(bundled)


def _accounts_from_results(results):
    """Keep only CLAIMED (found) sites; extract url + tags + any parsed ids/profile fields.

    search() returns {site_name: entry_dict}; entry_dict['status'] is a MaigretCheckResult carrying
    .status (a MaigretCheckStatus enum), .site_url_user, .ids_data, .tags.
    """
    out = []
    for site_name, entry in (results or {}).items():
        st = entry.get("status") if isinstance(entry, dict) else None
        if st is None:
            continue
        if getattr(st, "status", None) != MaigretCheckStatus.CLAIMED:
            continue
        out.append({
            "site": getattr(st, "site_name", site_name),
            "url": getattr(st, "site_url_user", None),
            "tags": list(getattr(st, "tags", []) or []),
            "ids": dict(getattr(st, "ids_data", {}) or {}),
        })
    out.sort(key=lambda a: str(a["site"]).lower())
    return out


async def _search_one(username, sites, timeout, logger):
    results = await maigret.search(
        username=username, site_dict=sites, logger=logger,
        timeout=timeout, is_parsing_enabled=True, id_type="username",
        no_progressbar=True, retries=0,
    )
    return {"username": username, "accounts": _accounts_from_results(results)}


async def _run(job):
    usernames = [str(u).strip() for u in (job.get("usernames") or []) if str(u).strip()]
    top_sites = int(job.get("top_sites", 30))
    timeout = int(job.get("timeout", 8))
    logger = logging.getLogger("maigret")
    logger.setLevel(logging.CRITICAL)  # silence — machine output only

    db = _load_db()
    sites = db.ranked_sites_dict(top=top_sites)

    results = []
    for u in usernames:
        try:
            results.append(await _search_one(u, sites, timeout, logger))
        except Exception as e:  # one username failing never kills the batch
            results.append({"username": u, "accounts": [], "error": str(e)[:200]})
    return {"ok": True, "count": len(results), "results": results}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", help="job JSON file (else stdin)")
    ap.add_argument("--out", help="results JSON file (else stdout)")
    args = ap.parse_args()

    raw = open(args.job, encoding="utf-8").read() if args.job else sys.stdin.read()
    job = json.loads(raw)

    try:
        out = asyncio.run(_run(job))
    except Exception as e:
        out = {"ok": False, "error": str(e)[:300], "results": []}

    text = json.dumps(out, ensure_ascii=False, indent=1)
    if args.out:
        open(args.out, "w", encoding="utf-8").write(text)
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
