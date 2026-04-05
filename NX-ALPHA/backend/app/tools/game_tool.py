"""
Game Tool — AURA plays Gymnasium and AgentGym environments.

AURA acts as the agent, using its LLM to decide actions each step.
Game state streams live to the canvas via render_canvas SSE events.

Trigger phrases: "play a game", "you should play a game", "play CartPole", etc.
"""

from __future__ import annotations

import logging

from app.tools._mcp_wrapper import _error

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "play_game",
    "description": (
        "Play a game using AURA's own reasoning as the agent. "
        "AURA will make decisions each step and stream the game state live to the canvas. "
        "Actions: "
        "(1) list_games — show all available game environments. "
        "(2) start — start a new game session (AURA begins playing immediately). "
        "(3) stop — stop the current or a specific game session. "
        "(4) status — check session status and score. "
        "Trigger phrases: 'play a game', 'you should play a game', 'play CartPole', 'try LunarLander'. "
        "Gymnasium games (no install needed): CartPole-v1, MountainCar-v0, LunarLander-v2, Acrobot-v1. "
        "AgentGym games (require pip install agentgym): sciworld, alfworld."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["list_games", "start", "stop", "status"],
                "description": "Game action to perform",
            },
            "env_name": {
                "type": "string",
                "description": (
                    "Environment name to play. "
                    "Gymnasium: CartPole-v1, MountainCar-v0, LunarLander-v2, Acrobot-v1. "
                    "AgentGym: sciworld, alfworld."
                ),
            },
            "max_steps": {
                "type": "integer",
                "description": "Maximum number of game steps before auto-stopping (default: 200)",
                "default": 200,
            },
            "session_id": {
                "type": "string",
                "description": "Session ID for stop/status actions. Omit to use the most recent session.",
            },
        },
        "required": ["action"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    from app.service.game_session_service import (
        GameSessionService,
        GYMNASIUM_ENVS,
        AGENTGYM_ENVS,
    )

    action = inputs.get("action", "")
    svc = GameSessionService.get_instance()

    if action == "list_games":
        gymnasium_list = [
            {
                "name": name,
                "type": "gymnasium",
                "description": info["description"],
                "actions": list(info.get("action_labels", {}).values()),
            }
            for name, info in GYMNASIUM_ENVS.items()
        ]
        agentgym_list = [
            {"name": name, "type": "agentgym", "description": info["description"]}
            for name, info in AGENTGYM_ENVS.items()
        ]
        return {
            "gymnasium": gymnasium_list,
            "agentgym": agentgym_list,
            "note": (
                "Gymnasium games are ready to play. "
                "AgentGym games require: pip install agentgym"
            ),
        }

    elif action == "start":
        env_name = inputs.get("env_name", "CartPole-v1")
        max_steps = int(inputs.get("max_steps", 200))

        session = await svc.start_session(env_name=env_name, max_steps=max_steps)
        return {
            "session_id": session.session_id,
            "env_name": session.env_name,
            "env_type": session.env_type,
            "status": session.status,
            "max_steps": max_steps,
            "message": (
                f"Started {env_name}. "
                "Watch the canvas — game state will update every 0.5 seconds. "
                "Say 'stop the game' to end the session."
            ),
        }

    elif action == "stop":
        session_id = inputs.get("session_id") or svc.get_latest_session_id()
        if not session_id:
            return _error("No active game session to stop")
        stopped = await svc.stop_session(session_id)
        if not stopped:
            return _error(f"Session {session_id} not found")
        session = svc.get_session(session_id)
        return {
            "stopped": True,
            "session_id": session_id,
            "final_score": round(session.total_reward, 2) if session else None,
            "steps": session.step_count if session else None,
        }

    elif action == "status":
        session_id = inputs.get("session_id") or svc.get_latest_session_id()
        if not session_id:
            sessions = svc.list_sessions()
            return {"sessions": sessions, "count": len(sessions)}
        session = svc.get_session(session_id)
        if not session:
            return _error(f"Session {session_id} not found")
        return {
            "session_id": session.session_id,
            "env_name": session.env_name,
            "env_type": session.env_type,
            "status": session.status,
            "step_count": session.step_count,
            "total_reward": round(session.total_reward, 2),
        }

    return _error(f"Unknown action: {action}")
