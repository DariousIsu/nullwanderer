"""
AURA NX-Alpha — Universal ZIM → FTS5 Indexer
Processes ANY ZIM file (Wikipedia, Stack Exchange, DevDocs, Wiktionary, etc.)
into a searchable SQLite FTS5 database.

REQUIREMENTS:
    pip install libzim html2text

USAGE (single ZIM):
    python scripts/build_zim_index.py --zim /path/to/file.zim --db ~/.aura/knowledge/source/fts5.db

USAGE (batch — all ZIMs in knowledge dir):
    python scripts/build_zim_index.py --batch

    Scans ~/.aura/knowledge/*/*.zim and indexes each one that doesn't
    already have a fts5.db alongside it.

USAGE (from Python — called by knowledge_downloader after download):
    from scripts.build_zim_index import index_zim
    index_zim("/path/to/file.zim", "/path/to/output/fts5.db")
"""

import argparse
import collections
import logging
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

# ─────────────────────────────────────────────────────────────────────────────
# SCHEMA — unified for all ZIM content
# ─────────────────────────────────────────────────────────────────────────────

DDL = """
CREATE TABLE IF NOT EXISTS articles (
    rowid    INTEGER PRIMARY KEY,
    title    TEXT NOT NULL,
    url      TEXT,
    content  TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
    title,
    content,
    content=articles,
    content_rowid=rowid,
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
    INSERT INTO articles_fts(rowid, title, content)
    VALUES (new.rowid, new.title, new.content);
END;
"""

# ─────────────────────────────────────────────────────────────────────────────
# PROGRESS DISPLAY
# ─────────────────────────────────────────────────────────────────────────────

_RATE_WINDOW_S = 15   # rolling window for rate calculation (seconds)
_BAR_WIDTH     = 28   # width of the progress bar fill


def _fmt_duration(seconds: float) -> str:
    """Format seconds into H:MM:SS or M:SS."""
    s = int(seconds)
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{sec:02d}"
    return f"{m}:{sec:02d}"


def _fmt_count(n: int) -> str:
    """Format large integers with comma separators."""
    return f"{n:,}"


class _ProgressDisplay:
    """
    Terminal progress display for ZIM indexing.

    When stdout is a TTY: rewrites a single line in-place using \\r.
    When piped/non-interactive: prints a new line every _LOG_INTERVAL entries.

    Tracks a rolling rate window so ETA is stable and accurate even when
    early entries are fast (redirects) and later ones are slow (large articles).

    The ETA is based on entries processed (not articles indexed), because
    the total count is entry_count not article_count — same denominator used
    throughout avoids drift.
    """

    _LOG_INTERVAL = 10_000   # lines to log when not a TTY
    _PRINT_INTERVAL_S = 0.25 # minimum seconds between TTY refreshes

    def __init__(self, zim_name: str, total_entries: int, is_library_call: bool = False):
        self._name          = zim_name[:35]
        self._total         = total_entries
        self._is_tty        = sys.stdout.isatty() and not is_library_call
        self._is_library    = is_library_call
        self._t0            = time.time()
        self._last_print    = 0.0
        self._last_log_at   = 0        # entry index of last log line (non-TTY)

        # Rolling window: deque of (timestamp, entries_processed_at_that_point)
        self._window: collections.deque = collections.deque()
        self._window_duration = _RATE_WINDOW_S

        if self._is_tty:
            # Reserve the line; hide cursor
            sys.stdout.write("\n")
            sys.stdout.flush()

    def update(self, idx: int, indexed: int, skipped: int) -> None:
        """
        Called every entry (or at least every batch commit).
        idx: current zero-based entry index in the ZIM
        indexed: articles successfully written so far
        skipped: entries skipped (redirects, images, too-short)
        """
        if self._is_library:
            return

        now = time.time()
        entries_done = idx + 1

        # Maintain rolling window
        self._window.append((now, entries_done))
        cutoff = now - self._window_duration
        while self._window and self._window[0][0] < cutoff:
            self._window.popleft()

        if self._is_tty:
            if now - self._last_print < self._PRINT_INTERVAL_S:
                return
            self._last_print = now
            self._render_tty(entries_done, indexed, skipped, now)
        else:
            if entries_done - self._last_log_at >= self._LOG_INTERVAL:
                self._last_log_at = entries_done
                self._render_log(entries_done, indexed, skipped, now)

    def _rate_and_eta(self, entries_done: int, now: float) -> tuple[float, Optional[float]]:
        """
        Returns (entries_per_sec, eta_seconds_remaining).
        Rate is computed over the rolling window for stability.
        ETA is None if rate is zero or total is unknown.
        """
        if len(self._window) >= 2:
            oldest_t, oldest_n = self._window[0]
            rate = (entries_done - oldest_n) / max(now - oldest_t, 0.001)
        else:
            elapsed = max(now - self._t0, 0.001)
            rate = entries_done / elapsed

        if rate > 0 and self._total > 0:
            remaining = (self._total - entries_done) / rate
        else:
            remaining = None

        return rate, remaining

    def _progress_bar(self, pct: float) -> str:
        filled = int(_BAR_WIDTH * pct / 100)
        bar = "█" * filled + "░" * (_BAR_WIDTH - filled)
        return f"[{bar}]"

    def _render_tty(self, entries_done: int, indexed: int, skipped: int, now: float) -> None:
        pct = (entries_done / self._total * 100) if self._total else 0
        rate, eta = self._rate_and_eta(entries_done, now)
        elapsed = now - self._t0

        bar     = self._progress_bar(pct)
        eta_str = _fmt_duration(eta) if eta is not None else "--:--"
        rate_k  = rate / 1000

        # Fit everything into terminal width, truncating name if needed
        term_w  = shutil.get_terminal_size((120, 24)).columns
        line = (
            f"\r{self._name} {bar} {pct:5.1f}% "
            f"| {_fmt_count(indexed)} indexed  {_fmt_count(skipped)} skipped "
            f"| {rate_k:.1f}k ent/s "
            f"| elapsed {_fmt_duration(elapsed)} "
            f"| ETA {eta_str}  "
        )
        # Truncate to terminal width to avoid wrapping
        if len(line) > term_w:
            line = line[:term_w - 1]

        sys.stdout.write(line)
        sys.stdout.flush()

    def _render_log(self, entries_done: int, indexed: int, skipped: int, now: float) -> None:
        pct = (entries_done / self._total * 100) if self._total else 0
        rate, eta = self._rate_and_eta(entries_done, now)
        elapsed = now - self._t0
        eta_str = _fmt_duration(eta) if eta is not None else "unknown"
        logger.info(
            "[%s] %5.1f%% — %s indexed, %s skipped | %.0f ent/s | elapsed %s | ETA %s",
            self._name, pct,
            _fmt_count(indexed), _fmt_count(skipped),
            rate, _fmt_duration(elapsed), eta_str,
        )

    def finish(self, indexed: int, skipped: int) -> None:
        """Print final summary line."""
        if self._is_library:
            return
        elapsed = time.time() - self._t0
        if self._is_tty:
            # Overwrite progress line with final summary
            term_w = shutil.get_terminal_size((120, 24)).columns
            line = (
                f"\r{self._name} [{'█' * _BAR_WIDTH}] 100.0% "
                f"| {_fmt_count(indexed)} indexed  {_fmt_count(skipped)} skipped "
                f"| done in {_fmt_duration(elapsed)}          "
            )
            sys.stdout.write(line[:term_w - 1] + "\n")
            sys.stdout.flush()
        else:
            logger.info(
                "[%s] DONE — %s articles indexed, %s skipped in %s",
                self._name,
                _fmt_count(indexed), _fmt_count(skipped),
                _fmt_duration(elapsed),
            )


# ─────────────────────────────────────────────────────────────────────────────
# ZIM INDEXER
# ─────────────────────────────────────────────────────────────────────────────

# Content truncation — 50k chars ≈ 12k tokens, keeps DB sane
_MAX_CONTENT_CHARS = 50_000
_MIN_CONTENT_CHARS = 50
_BATCH_SIZE        = 500


def index_zim(
    zim_path: str | Path,
    db_path: str | Path,
    limit: int = 0,
    progress_callback: Optional[Callable[[int, int, int], None]] = None,
) -> dict:
    """
    Index a ZIM file into an FTS5 SQLite database.

    Args:
        zim_path:          Path to the .zim file
        db_path:           Output SQLite database path
        limit:             Max articles to index (0 = all)
        progress_callback: fn(indexed, skipped, total) called every batch commit.
                           When provided (library/backend calls), terminal display
                           is suppressed and only this callback is used.

    Returns:
        {"indexed": int, "skipped": int, "elapsed_s": float, "db": str}
        On failure: {"error": str}
    """
    try:
        from libzim.reader import Archive
    except ImportError:
        logger.error("libzim not installed. Run: pip install libzim")
        return {"error": "libzim not installed"}

    try:
        import html2text
        h = html2text.HTML2Text()
        h.ignore_links = True
        h.ignore_images = True
        h.ignore_emphasis = True
        h.body_width = 0  # no line wrapping
    except ImportError:
        logger.error("html2text not installed. Run: pip install html2text")
        return {"error": "html2text not installed"}

    zim_path = Path(zim_path)
    db_path  = Path(db_path).expanduser()
    db_path.parent.mkdir(parents=True, exist_ok=True)

    if not zim_path.exists():
        logger.error("ZIM file not found: %s", zim_path)
        return {"error": f"ZIM not found: {zim_path}"}

    t0 = time.time()

    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-131072")   # 128 MB page cache
    conn.executescript(DDL)

    size_mb = zim_path.stat().st_size / 1e6
    logger.info("Opening ZIM: %s (%.1f MB)", zim_path.name, size_mb)
    archive = Archive(str(zim_path))
    total   = archive.entry_count
    logger.info("ZIM has %d entries", total)

    # Library calls (from backend) suppress terminal display
    is_library = progress_callback is not None
    display = _ProgressDisplay(zim_path.stem, total, is_library_call=is_library)

    batch:   list[tuple] = []
    indexed  = 0
    skipped  = 0

    for idx in range(total):
        if limit > 0 and indexed >= limit:
            break

        try:
            entry = archive._get_entry_by_id(idx)

            if entry.is_redirect:
                skipped += 1
                display.update(idx, indexed, skipped)
                continue

            item = entry.get_item()
            mime = item.mimetype

            # Accept HTML content only
            if not mime.startswith("text/html"):
                skipped += 1
                display.update(idx, indexed, skipped)
                continue

            raw  = bytes(item.content).decode("utf-8", errors="replace")
            text = h.handle(raw).strip()

            if len(text) < _MIN_CONTENT_CHARS:
                skipped += 1
                display.update(idx, indexed, skipped)
                continue

            batch.append((entry.title, entry.path, text[:_MAX_CONTENT_CHARS]))
            indexed += 1

        except Exception as exc:
            logger.debug("Skipping entry %d: %s", idx, exc)
            skipped += 1

        display.update(idx, indexed, skipped)

        if len(batch) >= _BATCH_SIZE:
            conn.executemany(
                "INSERT INTO articles(title, url, content) VALUES (?, ?, ?)",
                batch,
            )
            conn.commit()
            batch.clear()

            if progress_callback:
                progress_callback(indexed, skipped, total)

    # Flush remaining batch
    if batch:
        conn.executemany(
            "INSERT INTO articles(title, url, content) VALUES (?, ?, ?)",
            batch,
        )
        conn.commit()

    # Optimize FTS5 index and checkpoint WAL so the DB is immediately usable
    # without replaying the WAL on every new connection (which causes hangs
    # on large DBs like Wikipedia).
    logger.info("Optimizing FTS5 index...")
    conn.execute("INSERT INTO articles_fts(articles_fts) VALUES('optimize')")
    conn.commit()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.commit()
    conn.close()

    elapsed = time.time() - t0
    display.finish(indexed, skipped)

    db_size_mb = db_path.stat().st_size / 1e6
    logger.info(
        "Complete: %s → %s articles, %s skipped, %s in DB (%.1fs)",
        zim_path.name,
        _fmt_count(indexed), _fmt_count(skipped),
        f"{db_size_mb:.1f} MB",
        elapsed,
    )

    return {
        "indexed":    indexed,
        "skipped":    skipped,
        "elapsed_s":  round(elapsed, 1),
        "db":         str(db_path),
    }


# ─────────────────────────────────────────────────────────────────────────────
# BATCH MODE — find all ZIMs and index those without a fts5.db
# ─────────────────────────────────────────────────────────────────────────────

def batch_index(knowledge_root: str | Path = "~/.aura/knowledge", force: bool = False) -> list[dict]:
    """
    Scan knowledge_root for all .zim files and index any that don't
    already have a fts5.db next to them.

    Args:
        knowledge_root: Root knowledge directory
        force:          Re-index even if fts5.db already exists

    Returns:
        List of result dicts from index_zim()
    """
    root = Path(knowledge_root).expanduser()
    if not root.exists():
        logger.error("Knowledge root does not exist: %s", root)
        return []

    zim_files = sorted(root.rglob("*.zim"))
    if not zim_files:
        logger.info("No ZIM files found in %s", root)
        return []

    # Separate into needs-index and will-skip
    to_index = []
    to_skip  = []
    for z in zim_files:
        db = z.parent / "fts5.db"
        if db.exists() and not force:
            to_skip.append(z)
        else:
            to_index.append(z)

    # Print job summary
    total_size_gb = sum(z.stat().st_size for z in to_index) / 1e9
    print(f"\n{'═' * 70}")
    print(f"  AURA Knowledge Indexer — Batch Mode")
    print(f"{'═' * 70}")
    print(f"  Root:        {root}")
    print(f"  To index:    {len(to_index)} ZIM(s)  ({total_size_gb:.1f} GB total)")
    print(f"  Already done:{len(to_skip)} ZIM(s)  (skipping)")
    if to_index:
        print(f"\n  Queue:")
        for i, z in enumerate(to_index, 1):
            size_mb = z.stat().st_size / 1e6
            print(f"    {i}. {z.name}  ({size_mb:.0f} MB)")
    print(f"{'─' * 70}\n")

    if not to_index:
        print("  Nothing to do. Use --force to re-index existing databases.\n")
        return [{"zim": z.name, "status": "skipped", "reason": "fts5.db exists"} for z in to_skip]

    results   = []
    batch_t0  = time.time()

    for i, zim_path in enumerate(to_index, 1):
        db_path = zim_path.parent / "fts5.db"

        if db_path.exists() and force:
            logger.info("FORCE re-index: removing %s", db_path)
            db_path.unlink()

        size_mb = zim_path.stat().st_size / 1e6
        print(f"[{i}/{len(to_index)}] {zim_path.name}  ({size_mb:.0f} MB)")

        result = index_zim(zim_path, db_path)
        result["zim"] = zim_path.name
        results.append(result)

        # Per-ZIM outcome line
        if "error" in result:
            print(f"  ✗ ERROR: {result['error']}\n")
        else:
            db_size_mb = Path(db_path).stat().st_size / 1e6 if db_path.exists() else 0
            print(
                f"  ✓ {_fmt_count(result['indexed'])} articles  "
                f"| {_fmt_duration(result['elapsed_s'])} elapsed  "
                f"| {db_size_mb:.0f} MB DB\n"
            )

    # Append skipped entries to results list
    for z in to_skip:
        results.append({"zim": z.name, "status": "skipped", "reason": "fts5.db exists"})

    # Final summary
    total_elapsed = time.time() - batch_t0
    total_indexed = sum(r.get("indexed", 0) for r in results)
    errors        = [r for r in results if "error" in r]

    print(f"{'═' * 70}")
    print(f"  BATCH COMPLETE")
    print(f"{'─' * 70}")
    print(f"  ZIMs indexed:  {len(to_index)}")
    print(f"  ZIMs skipped:  {len(to_skip)}")
    print(f"  Total articles:{_fmt_count(total_indexed)}")
    print(f"  Total time:    {_fmt_duration(total_elapsed)}")
    if errors:
        print(f"  Errors ({len(errors)}):")
        for r in errors:
            print(f"    ✗ {r.get('zim', '?')}: {r['error']}")
    print(f"{'═' * 70}\n")

    return results


# ─────────────────────────────────────────────────────────────────────────────
# CLI ENTRY
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Index ZIM files into FTS5 SQLite databases for AURA knowledge search"
    )
    parser.add_argument("--zim",   help="Path to a single ZIM file")
    parser.add_argument("--db",    help="Output SQLite DB path (default: fts5.db next to ZIM)")
    parser.add_argument("--limit", type=int, default=0, help="Max articles to index (0 = all)")
    parser.add_argument("--batch", action="store_true", help="Index all unindexed ZIMs in the knowledge root")
    parser.add_argument("--root",  default="~/.aura/knowledge", help="Knowledge root directory for --batch")
    parser.add_argument("--force", action="store_true", help="Re-index even if fts5.db already exists")
    args = parser.parse_args()

    if args.batch:
        batch_index(args.root, force=args.force)
    elif args.zim:
        db = args.db or str(Path(args.zim).parent / "fts5.db")
        index_zim(args.zim, db, limit=args.limit)
    else:
        parser.print_help()
        print("\nExamples:")
        print("  python scripts/build_zim_index.py --batch")
        print("  python scripts/build_zim_index.py --zim ~/.aura/knowledge/wikipedia/wiki.zim")
        print("  python scripts/build_zim_index.py --zim ~/.aura/knowledge/wikipedia/wiki.zim --force")
        sys.exit(1)
