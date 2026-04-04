"""
AURA NX-Alpha — User Profile Controller
REST endpoints for reading and managing the persistent user profile.

ROUTES:
    GET    /profile                     — full profile JSON
    PUT    /profile/field               — manual field override
    DELETE /profile/field               — remove a field entry
    POST   /profile/reset               — clear all profile data
"""

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/profile", tags=["profile"])


def _svc():
    from app.service.user_profile_service import get_user_profile_service
    svc = get_user_profile_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="User profile service not initialized")
    return svc


class ProfileFieldBody(BaseModel):
    field: str
    value: str
    confidence: float = 0.9


class DeleteFieldBody(BaseModel):
    field: str
    value: str


@router.get("")
async def get_profile():
    """Return the full user profile grouped by field."""
    return _svc().get_profile()


@router.put("/field")
async def upsert_field(body: ProfileFieldBody):
    """Manually insert or update a profile field entry."""
    svc = _svc()
    if body.field not in svc.VALID_FIELDS:
        raise HTTPException(status_code=400, detail=f"Invalid field. Must be one of: {svc.VALID_FIELDS}")
    svc._upsert_signal(body.field, body.value, source_thread="manual")
    svc._store_l2(body.field, body.value)
    return {"ok": True, "field": body.field, "value": body.value}


@router.delete("/field")
async def delete_field(body: DeleteFieldBody):
    """Remove a specific (field, value) pair from the profile."""
    removed = _svc().delete_field_value(body.field, body.value)
    if not removed:
        raise HTTPException(status_code=404, detail="Field/value pair not found")
    return {"ok": True}


@router.post("/reset")
async def reset_profile():
    """Clear all user profile data."""
    count = _svc().reset()
    logger.info("[profile] Profile reset — %d entries removed", count)
    return {"ok": True, "removed": count}
