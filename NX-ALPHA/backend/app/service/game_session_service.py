"""
Game Session Service — lets AURA play Gymnasium and AgentGym environments.

AURA's Interface Engine acts as the agent, deciding actions each step via LLM.
Game state is streamed live to the canvas via render_canvas SSE events.

Supported environments:
  Gymnasium (classic-control): CartPole-v1, MountainCar-v0, LunarLander-v2, Acrobot-v1
  AgentGym: sciworld, alfworld (install separately: pip install agentgym)

Trigger: user says "Aura, you should play a game" or "play CartPole"
"""

import asyncio
import logging
import random
import re
import time
from dataclasses import dataclass, field
from typing import Optional
from uuid import uuid4

logger = logging.getLogger(__name__)

# ── Environment registry ──────────────────────────────────────────────────────

GYMNASIUM_ENVS = {
    "CartPole-v1": {
        "description": "Balance a pole on a cart. Keep it upright as long as possible.",
        "action_labels": {0: "push left", 1: "push right"},
        "obs_labels": ["cart_pos", "cart_vel", "pole_angle", "pole_vel"],
    },
    "MountainCar-v0": {
        "description": "Drive a car up a mountain by building momentum.",
        "action_labels": {0: "push left", 1: "no push", 2: "push right"},
        "obs_labels": ["position", "velocity"],
    },
    "LunarLander-v2": {
        "description": "Land a spacecraft safely between the flags.",
        "action_labels": {0: "do nothing", 1: "fire left engine", 2: "fire main engine", 3: "fire right engine"},
        "obs_labels": ["x", "y", "vel_x", "vel_y", "angle", "ang_vel", "left_leg", "right_leg"],
    },
    "Acrobot-v1": {
        "description": "Swing a two-link robot arm to reach the target height.",
        "action_labels": {0: "apply -1 torque", 1: "apply 0 torque", 2: "apply +1 torque"},
        "obs_labels": ["cos_theta1", "sin_theta1", "cos_theta2", "sin_theta2", "dtheta1", "dtheta2"],
    },
}

AGENTGYM_ENVS = {
    "sciworld": {"description": "Complete science experiments in a text-based lab."},
    "alfworld": {"description": "Complete household tasks in a text-based world."},
}

ALL_ENVS = {**GYMNASIUM_ENVS, **AGENTGYM_ENVS}


# ── Session dataclass ─────────────────────────────────────────────────────────

@dataclass
class GameSession:
    session_id: str
    env_type: str          # "gymnasium" | "agentgym"
    env_name: str
    status: str = "running"  # "running" | "done" | "error"
    step_count: int = 0
    total_reward: float = 0.0
    started_at: float = field(default_factory=time.time)
    task: Optional[asyncio.Task] = field(default=None, repr=False)


# ── LLM action decision ───────────────────────────────────────────────────────

async def _llm_decide_action(env_name: str, obs, n_actions: int) -> int:
    """
    Ask the Interface Engine to choose the next action.
    Falls back to random on parse failure or unavailability.
    """
    env_info = GYMNASIUM_ENVS.get(env_name, {})
    obs_labels = env_info.get("obs_labels", [])
    action_labels = env_info.get("action_labels", {})
    desc = env_info.get("description", env_name)

    # Format observation with labels when available
    if obs_labels and hasattr(obs, "__iter__"):
        obs_parts = []
        for i, val in enumerate(obs):
            label = obs_labels[i] if i < len(obs_labels) else f"obs_{i}"
            obs_parts.append(f"{label}={float(val):.4f}")
        obs_str = ", ".join(obs_parts)
    else:
        obs_str = str(obs)[:300]

    # Format available actions
    if action_labels:
        action_str = ", ".join(f"{k}={v}" for k, v in action_labels.items())
    else:
        action_str = ", ".join(str(i) for i in range(n_actions))

    prompt = (
        f"You are playing {env_name}. {desc}\n"
        f"Current observation: {obs_str}\n"
        f"Available actions: {action_str}\n"
        f"Choose the best action number. Respond with ONLY the integer action number, nothing else."
    )

    messages = [{"role": "user", "content": prompt}]

    try:
        from app.service.interface_engine import get_engine
        engine = get_engine()
        if engine is None:
            raise RuntimeError("Interface engine not loaded")
        result = await engine.generate(messages, max_tokens=16, temperature=0.3)
        text = result.get("text", "").strip()
        match = re.search(r"\b(\d+)\b", text)
        if match:
            action = int(match.group(1))
            return max(0, min(action, n_actions - 1))
    except Exception as exc:
        logger.warning("[game] LLM action decision failed: %s — using random", exc)

    return random.randint(0, n_actions - 1)


# ── Canvas event builder ──────────────────────────────────────────────────────

def _build_canvas_event(session: GameSession, obs, reward: float, action: int, step: int) -> dict:
    env_info = GYMNASIUM_ENVS.get(session.env_name, {})
    action_labels = env_info.get("action_labels", {})
    action_label = action_labels.get(action, str(action))

    obs_str = str(obs)
    if hasattr(obs, "__iter__"):
        try:
            obs_str = "[" + ", ".join(f"{float(v):.3f}" for v in obs) + "]"
        except Exception:
            pass
    obs_str = obs_str[:400]

    return {
        "title": f"{session.env_name} — Step {step}",
        "blocks": [{
            "type": "game_state",
            "data": {
                "env_name": session.env_name,
                "step": step,
                "action_taken": action,
                "action_label": action_label,
                "reward": reward,
                "total_reward": round(session.total_reward, 2),
                "observation": obs_str,
                "status": session.status,
            },
        }],
    }


# ── Game loops ────────────────────────────────────────────────────────────────

async def _run_gymnasium(session: GameSession, max_steps: int):
    """Run a Gymnasium environment game loop."""
    try:
        import gymnasium as gym  # type: ignore
    except ImportError:
        session.status = "error"
        logger.error("[game] gymnasium not installed. Run: pip install gymnasium gymnasium[classic-control]")
        return

    try:
        env = gym.make(session.env_name)
    except Exception as exc:
        session.status = "error"
        logger.error("[game] Failed to create env %s: %s", session.env_name, exc)
        return

    try:
        from app.controller.chat_controller import _emit

        obs, _info = env.reset()
        n_actions = env.action_space.n

        for step in range(1, max_steps + 1):
            action = await _llm_decide_action(session.env_name, obs, n_actions)
            obs, reward, terminated, truncated, _info = env.step(action)

            session.step_count = step
            session.total_reward += float(reward)

            await _emit("render_canvas", _build_canvas_event(session, obs, float(reward), action, step))
            await asyncio.sleep(0.5)  # pace updates so frontend can render

            if terminated or truncated:
                break

        session.status = "done"
        # Final summary event
        await _emit("render_canvas", {
            "title": f"{session.env_name} — Game Over",
            "blocks": [{
                "type": "game_state",
                "data": {
                    "env_name": session.env_name,
                    "step": session.step_count,
                    "action_taken": -1,
                    "action_label": "—",
                    "reward": 0,
                    "total_reward": round(session.total_reward, 2),
                    "observation": "Game finished",
                    "status": "done",
                },
            }],
        })
    except asyncio.CancelledError:
        session.status = "done"
        raise
    except Exception as exc:
        session.status = "error"
        logger.error("[game] Game loop error: %s", exc)
    finally:
        try:
            env.close()
        except Exception:
            pass


async def _run_agentgym(session: GameSession, max_steps: int):
    """Run an AgentGym environment game loop (text-based)."""
    try:
        import agentgym  # type: ignore  # noqa: F401
    except ImportError:
        session.status = "error"
        logger.error("[game] agentgym not installed. Run: pip install agentgym")
        return

    # AgentGym environments have varied setup requirements.
    # Basic text loop pattern — environment-specific wrappers may differ.
    logger.warning("[game] AgentGym support is experimental. Environment: %s", session.env_name)
    session.status = "error"
    try:
        from app.controller.chat_controller import _emit
        await _emit("render_canvas", {
            "title": f"AgentGym — {session.env_name}",
            "blocks": [{
                "type": "callout",
                "data": {
                    "level": "warning",
                    "text": (
                        f"AgentGym environment '{session.env_name}' requires additional setup. "
                        "See: https://github.com/WooooDyy/AgentGym for environment-specific instructions."
                    ),
                },
            }],
        })
    except Exception:
        pass


# ── Service ───────────────────────────────────────────────────────────────────

class GameSessionService:
    """Manages active game sessions and their async game loops."""

    _instance: Optional["GameSessionService"] = None

    def __init__(self):
        self._sessions: dict[str, GameSession] = {}
        self._latest_session_id: Optional[str] = None

    @classmethod
    def get_instance(cls) -> "GameSessionService":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def list_sessions(self) -> list[dict]:
        return [
            {
                "session_id": s.session_id,
                "env_name": s.env_name,
                "env_type": s.env_type,
                "status": s.status,
                "step_count": s.step_count,
                "total_reward": round(s.total_reward, 2),
                "started_at": s.started_at,
            }
            for s in self._sessions.values()
        ]

    def get_session(self, session_id: str) -> Optional[GameSession]:
        return self._sessions.get(session_id)

    def get_latest_session_id(self) -> Optional[str]:
        return self._latest_session_id

    async def start_session(
        self,
        env_name: str,
        env_type: Optional[str] = None,
        max_steps: int = 200,
    ) -> GameSession:
        """Start a new game session. Returns immediately; game loop runs in background."""
        if env_type is None:
            env_type = "agentgym" if env_name in AGENTGYM_ENVS else "gymnasium"

        session = GameSession(
            session_id=str(uuid4()),
            env_type=env_type,
            env_name=env_name,
        )
        self._sessions[session.session_id] = session
        self._latest_session_id = session.session_id

        if env_type == "agentgym":
            loop_fn = _run_agentgym
        else:
            loop_fn = _run_gymnasium

        session.task = asyncio.create_task(loop_fn(session, max_steps))
        logger.info("[game] Session %s started: %s (%s)", session.session_id[:8], env_name, env_type)
        return session

    async def stop_session(self, session_id: str) -> bool:
        """Stop a running game session."""
        session = self._sessions.get(session_id)
        if not session:
            return False
        if session.task and not session.task.done():
            session.task.cancel()
            try:
                await session.task
            except asyncio.CancelledError:
                pass
        session.status = "done"
        logger.info("[game] Session %s stopped", session_id[:8])
        return True
