"""
AURA NX-Alpha — Game Controller
REST endpoints for Gymnasium / AgentGym game sessions.

ROUTES:
    GET    /game/games                 — list available environments
    GET    /game/sessions              — list all sessions
    GET    /game/sessions/{session_id} — single session detail
    POST   /game/sessions              — start a new session
    DELETE /game/sessions/{session_id} — stop a session
"""

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from app.service.game_session_service import (
    GameSessionService,
    GYMNASIUM_ENVS,
    AGENTGYM_ENVS,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/game", tags=["game"])


class StartSessionBody(BaseModel):
    env_name: str = "CartPole-v1"
    env_type: Optional[str] = None
    max_steps: int = 200


@router.get("/games")
async def list_games():
    """List all available game environments."""
    return {
        "gymnasium": [
            {
                "name": name,
                "type": "gymnasium",
                "description": info["description"],
                "action_labels": info.get("action_labels", {}),
                "obs_labels": info.get("obs_labels", []),
            }
            for name, info in GYMNASIUM_ENVS.items()
        ],
        "agentgym": [
            {"name": name, "type": "agentgym", "description": info["description"]}
            for name, info in AGENTGYM_ENVS.items()
        ],
    }


@router.get("/sessions")
async def list_sessions():
    """List all game sessions."""
    svc = GameSessionService.get_instance()
    return {"sessions": svc.list_sessions()}


@router.get("/sessions/{session_id}")
async def get_session(session_id: str):
    """Get detail on a single game session."""
    svc = GameSessionService.get_instance()
    session = svc.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    return {
        "session_id": session.session_id,
        "env_name": session.env_name,
        "env_type": session.env_type,
        "status": session.status,
        "step_count": session.step_count,
        "total_reward": round(session.total_reward, 2),
        "started_at": session.started_at,
    }


@router.post("/sessions", status_code=201)
async def start_session(body: StartSessionBody):
    """Start a new game session. Returns immediately; game loop runs in background."""
    svc = GameSessionService.get_instance()
    session = await svc.start_session(
        env_name=body.env_name,
        env_type=body.env_type,
        max_steps=body.max_steps,
    )
    return {
        "session_id": session.session_id,
        "env_name": session.env_name,
        "env_type": session.env_type,
        "status": session.status,
        "message": f"Game started. Watch the canvas for live updates.",
    }


@router.delete("/sessions/{session_id}")
async def stop_session(session_id: str):
    """Stop a running game session."""
    svc = GameSessionService.get_instance()
    stopped = await svc.stop_session(session_id)
    if not stopped:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    session = svc.get_session(session_id)
    return {
        "stopped": True,
        "session_id": session_id,
        "final_score": round(session.total_reward, 2) if session else None,
        "steps": session.step_count if session else None,
    }
