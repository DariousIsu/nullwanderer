"""
AURA NX-Alpha — Media Controller

HTTP endpoints for browser screencasting and yt-dlp media extraction.
  POST /media/extract        — extract direct stream URL via yt-dlp
  POST /media/screenshot     — one-shot PNG capture of a URL
  GET  /media/browser/stream — MJPEG stream of a live URL (bypasses X-Frame-Options)

The /media/browser/stream endpoint is used by Phase 7's StreetViewPanel and any
canvas browser_view block. Frontend: set <img src="/media/browser/stream?url=...">
"""
import base64

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter(prefix="/media", tags=["media"])


class MediaExtractRequest(BaseModel):
    url: str


class BrowserScreenshotRequest(BaseModel):
    url: str


@router.post("/extract")
async def extract_media(body: MediaExtractRequest):
    """
    Extract direct stream URL from a video hosting page via yt-dlp.
    Returns: { stream_url, title, thumbnail, duration, uploader, formats }
    """
    from app.service.media_service import get_video_info
    info = await get_video_info(body.url)
    if "error" in info:
        raise HTTPException(status_code=422, detail=info["error"])
    return info


@router.post("/screenshot")
async def take_screenshot(body: BrowserScreenshotRequest):
    """
    Navigate to URL and return a base64-encoded PNG screenshot.
    Use for one-shot page captures.
    Returns: { image_b64, mime }
    """
    from app.service.scraper_service import screenshot
    img_bytes = await screenshot(body.url)
    if not img_bytes:
        raise HTTPException(status_code=500, detail="Screenshot failed")
    return {"image_b64": base64.b64encode(img_bytes).decode(), "mime": "image/png"}


@router.get("/browser/stream")
async def browser_stream(url: str, fps: int = 8, max_frames: int = 120):
    """
    Stream JPEG frames of a URL as multipart/x-mixed-replace (MJPEG stream).
    Used by StreetViewPanel (P7) and any browser_view Canvas block.

    Frontend: set <img src="/media/browser/stream?url=..."> for live view.
    Bypasses X-Frame-Options entirely — screencasting, not embedding.
    """
    from app.service.scraper_service import screencast

    async def frame_generator():
        async for frame in screencast(url, fps=fps, max_frames=max_frames):
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n"
                + frame
                + b"\r\n"
            )

    return StreamingResponse(
        frame_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )
