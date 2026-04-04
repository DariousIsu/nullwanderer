"""
AURA NX-Alpha — Travel Planning Controller

TREK-inspired travel planning endpoints for trip itineraries, places,
reservations, budgets, routing, and POI search.

Endpoints:
  POST   /travel/trips                    — Create trip
  GET    /travel/trips                    — List trips
  GET    /travel/trips/{id}               — Get trip with full itinerary
  PUT    /travel/trips/{id}               — Update trip
  DELETE /travel/trips/{id}               — Delete trip
  POST   /travel/trips/{id}/days          — Add day to trip
  PUT    /travel/trips/{id}/days/reorder  — Reorder days
  DELETE /travel/days/{id}                — Delete day
  POST   /travel/days/{id}/places         — Add place to day
  PUT    /travel/places/{id}/move         — Move place between days
  DELETE /travel/places/{id}              — Delete place
  POST   /travel/trips/{id}/reservations  — Add reservation
  DELETE /travel/reservations/{id}        — Delete reservation
  POST   /travel/trips/{id}/expenses      — Add expense
  GET    /travel/trips/{id}/budget        — Get budget summary
  DELETE /travel/expenses/{id}            — Delete expense
  GET    /travel/trips/{id}/route         — Get optimized route (GeoJSON)
  GET    /travel/places/search            — POI search (Overpass + Nominatim)
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/travel", tags=["travel"])
logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# REQUEST MODELS
# ─────────────────────────────────────────────────────────────────────────────

class CreateTripRequest(BaseModel):
    name: str
    destination: str = ""
    start_date: str = ""
    end_date: str = ""
    notes: str = ""


class UpdateTripRequest(BaseModel):
    name: Optional[str] = None
    destination: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    notes: Optional[str] = None


class AddDayRequest(BaseModel):
    date: str
    label: str = ""


class ReorderDaysRequest(BaseModel):
    day_ids: list[int]


class AddPlaceRequest(BaseModel):
    name: str
    lat: float
    lon: float
    category: str = "other"
    notes: str = ""
    address: str = ""


class MovePlaceRequest(BaseModel):
    target_day_id: int
    sort_order: int = 0


class AddReservationRequest(BaseModel):
    type: str  # flight, hotel, restaurant, transport, activity, other
    title: str
    details: dict = {}
    date: str = ""
    end_date: str = ""
    confirmation: str = ""
    notes: str = ""


class AddExpenseRequest(BaseModel):
    description: str
    amount: float
    currency: str = "USD"
    category: str = "other"
    date: str = ""
    notes: str = ""


# ─────────────────────────────────────────────────────────────────────────────
# HELPER
# ─────────────────────────────────────────────────────────────────────────────

def _svc():
    from app.service.travel_service import get_travel_service
    try:
        return get_travel_service()
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Travel service not available")


# ─────────────────────────────────────────────────────────────────────────────
# TRIPS
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/trips")
async def create_trip(body: CreateTripRequest):
    """Create a new trip with optional auto-generated days."""
    svc = _svc()
    return svc.create_trip(
        name=body.name, destination=body.destination,
        start_date=body.start_date, end_date=body.end_date, notes=body.notes,
    )


@router.get("/trips")
async def list_trips():
    """List all trips."""
    return _svc().list_trips()


@router.get("/trips/{trip_id}")
async def get_trip(trip_id: int):
    """Get a trip with full itinerary, reservations, and expenses."""
    trip = _svc().get_trip(trip_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    return trip


@router.put("/trips/{trip_id}")
async def update_trip(trip_id: int, body: UpdateTripRequest):
    """Update trip metadata."""
    svc = _svc()
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    trip = svc.update_trip(trip_id, **updates)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    return trip


@router.delete("/trips/{trip_id}")
async def delete_trip(trip_id: int):
    """Delete a trip and all associated data."""
    _svc().delete_trip(trip_id)
    return {"deleted": True, "trip_id": trip_id}


# ─────────────────────────────────────────────────────────────────────────────
# DAYS
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/trips/{trip_id}/days")
async def add_day(trip_id: int, body: AddDayRequest):
    """Add a day to a trip."""
    return _svc().add_day(trip_id, date=body.date, label=body.label)


@router.put("/trips/{trip_id}/days/reorder")
async def reorder_days(trip_id: int, body: ReorderDaysRequest):
    """Reorder days within a trip."""
    return _svc().reorder_days(trip_id, body.day_ids)


@router.delete("/days/{day_id}")
async def delete_day(day_id: int):
    """Delete a day and its places."""
    _svc().delete_day(day_id)
    return {"deleted": True, "day_id": day_id}


# ─────────────────────────────────────────────────────────────────────────────
# PLACES
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/days/{day_id}/places")
async def add_place(day_id: int, body: AddPlaceRequest):
    """Add a place/waypoint to a day."""
    return _svc().add_place(
        day_id, name=body.name, lat=body.lat, lon=body.lon,
        category=body.category, notes=body.notes, address=body.address,
    )


@router.put("/places/{place_id}/move")
async def move_place(place_id: int, body: MovePlaceRequest):
    """Move a place to a different day."""
    return _svc().move_place(place_id, body.target_day_id, body.sort_order)


@router.delete("/places/{place_id}")
async def delete_place(place_id: int):
    """Delete a place."""
    _svc().delete_place(place_id)
    return {"deleted": True, "place_id": place_id}


# ─────────────────────────────────────────────────────────────────────────────
# RESERVATIONS
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/trips/{trip_id}/reservations")
async def add_reservation(trip_id: int, body: AddReservationRequest):
    """Add a reservation (flight, hotel, restaurant, etc.) to a trip."""
    return _svc().add_reservation(
        trip_id, type=body.type, title=body.title, details=body.details,
        date=body.date, end_date=body.end_date, confirmation=body.confirmation,
        notes=body.notes,
    )


@router.delete("/reservations/{res_id}")
async def delete_reservation(res_id: int):
    """Delete a reservation."""
    _svc().delete_reservation(res_id)
    return {"deleted": True, "reservation_id": res_id}


# ─────────────────────────────────────────────────────────────────────────────
# EXPENSES & BUDGET
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/trips/{trip_id}/expenses")
async def add_expense(trip_id: int, body: AddExpenseRequest):
    """Add an expense to a trip."""
    return _svc().add_expense(
        trip_id, description=body.description, amount=body.amount,
        currency=body.currency, category=body.category,
        date=body.date, notes=body.notes,
    )


@router.get("/trips/{trip_id}/budget")
async def get_budget(trip_id: int):
    """Get budget summary for a trip."""
    return _svc().get_budget(trip_id)


@router.delete("/expenses/{expense_id}")
async def delete_expense(expense_id: int):
    """Delete an expense."""
    _svc().delete_expense(expense_id)
    return {"deleted": True, "expense_id": expense_id}


# ─────────────────────────────────────────────────────────────────────────────
# ROUTING & POI SEARCH
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/trips/{trip_id}/route")
async def get_route(trip_id: int):
    """Get optimized driving route for all places in a trip (GeoJSON)."""
    return await _svc().get_route(trip_id)


@router.get("/places/search")
async def search_places(
    q: str = "",
    lat: float = 0,
    lon: float = 0,
    radius: int = 5000,
    category: str = "",
):
    """Search for points of interest near a location using Overpass API + Nominatim."""
    return await _svc().search_places(query=q, lat=lat, lon=lon, radius=radius, category=category)
