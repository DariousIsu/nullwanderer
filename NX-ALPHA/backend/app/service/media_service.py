"""
AURA NX-Alpha — Media Extraction Service

yt-dlp backend. Extracts direct stream URLs from YouTube, Twitch, Vimeo,
and 1000+ sites. No cloud APIs. Fully local. Falls back gracefully.
"""
import asyncio
import logging
from typing import Optional

logger = logging.getLogger(__name__)


async def extract_stream_url(url: str) -> Optional[str]:
    """
    Extract a direct playable media URL from a video hosting page.
    Returns the best direct stream URL (mp4/webm preferred), or None on failure.
    Does NOT download the video — returns only the stream URL.
    """
    try:
        import yt_dlp
        ydl_opts = {
            "format": "best[ext=mp4]/best[ext=webm]/best",
            "quiet": True,
            "no_warnings": True,
            "extract_flat": False,
        }
        loop = asyncio.get_running_loop()

        def _extract():
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                return info.get("url") or info.get("webpage_url")

        return await loop.run_in_executor(None, _extract)

    except Exception as exc:
        logger.warning("[media_service] Failed to extract stream URL for %s: %s", url, exc)
        return None


async def search_youtube(query: str, limit: int = 8) -> list[dict]:
    """
    Search YouTube via yt-dlp. Returns a list of video metadata dicts.
    Thumbnails available at img.youtube.com/vi/{id}/mqdefault.jpg — no API key needed.
    """
    try:
        import yt_dlp
        ydl_opts = {
            "quiet":       True,
            "no_warnings": True,
            "extract_flat": True,
        }
        loop = asyncio.get_running_loop()

        def _search():
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
                results = []
                for entry in (info.get("entries") or []):
                    vid_id = entry.get("id")
                    if not vid_id:
                        continue
                    results.append({
                        "id":       vid_id,
                        "title":    entry.get("title", ""),
                        "uploader": entry.get("uploader", ""),
                        "duration": entry.get("duration"),
                    })
                return results

        return await loop.run_in_executor(None, _search)

    except Exception as exc:
        logger.warning("[media_service] search_youtube failed for %r: %s", query, exc)
        return []


async def get_video_info(url: str) -> dict:
    """
    Extract metadata without downloading.
    Returns title, thumbnail, duration, uploader, stream_url, and last 5 format entries.
    """
    try:
        import yt_dlp
        ydl_opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
        }
        loop = asyncio.get_running_loop()

        def _info():
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                return {
                    "title":      info.get("title", ""),
                    "thumbnail":  info.get("thumbnail", ""),
                    "duration":   info.get("duration"),
                    "uploader":   info.get("uploader", ""),
                    "view_count": info.get("view_count"),
                    "stream_url": info.get("url"),
                    "formats": [
                        {
                            "ext":      f.get("ext"),
                            "quality":  f.get("quality"),
                            "url":      f.get("url"),
                            "filesize": f.get("filesize"),
                        }
                        for f in info.get("formats", [])[-5:]  # last 5 (best quality)
                    ],
                }

        return await loop.run_in_executor(None, _info)

    except Exception as exc:
        logger.warning("[media_service] Failed to get video info for %s: %s", url, exc)
        return {"error": str(exc)}
