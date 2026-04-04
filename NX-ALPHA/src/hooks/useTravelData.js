/**
 * AURA NX-Alpha — useTravelData hook
 *
 * REST client for the TREK-inspired travel planning API.
 * Manages trips, days, places, reservations, expenses, routing, and POI search.
 */

import { useState, useCallback } from 'react';

const API = 'http://localhost:8000';

async function _fetch(url, opts = {}) {
  const r = await fetch(`${API}${url}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

export function useTravelData() {
  const [trips,       setTrips]       = useState([]);
  const [activeTrip,  setActiveTrip]  = useState(null);
  const [route,       setRoute]       = useState(null);
  const [searchResults, setSearchResults] = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState(null);

  // ── Trips ────────────────────────────────────────────────────────────────

  const listTrips = useCallback(async () => {
    setLoading(true);
    try {
      const data = await _fetch('/travel/trips');
      setTrips(data);
      setError(null);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, []);

  const getTrip = useCallback(async (tripId) => {
    setLoading(true);
    try {
      const data = await _fetch(`/travel/trips/${tripId}`);
      setActiveTrip(data);
      setError(null);
      return data;
    } catch (e) { setError(e.message); return null; }
    finally { setLoading(false); }
  }, []);

  const createTrip = useCallback(async (tripData) => {
    try {
      const data = await _fetch('/travel/trips', {
        method: 'POST',
        body: JSON.stringify(tripData),
      });
      setActiveTrip(data);
      await listTrips();
      return data;
    } catch (e) { setError(e.message); return null; }
  }, [listTrips]);

  const updateTrip = useCallback(async (tripId, updates) => {
    try {
      const data = await _fetch(`/travel/trips/${tripId}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
      });
      setActiveTrip(data);
      return data;
    } catch (e) { setError(e.message); return null; }
  }, []);

  const deleteTrip = useCallback(async (tripId) => {
    try {
      await _fetch(`/travel/trips/${tripId}`, { method: 'DELETE' });
      setActiveTrip(null);
      await listTrips();
      return true;
    } catch (e) { setError(e.message); return false; }
  }, [listTrips]);

  // ── Days ─────────────────────────────────────────────────────────────────

  const addDay = useCallback(async (tripId, dayData) => {
    try {
      await _fetch(`/travel/trips/${tripId}/days`, {
        method: 'POST',
        body: JSON.stringify(dayData),
      });
      return await getTrip(tripId);
    } catch (e) { setError(e.message); return null; }
  }, [getTrip]);

  const reorderDays = useCallback(async (tripId, dayIds) => {
    try {
      await _fetch(`/travel/trips/${tripId}/days/reorder`, {
        method: 'PUT',
        body: JSON.stringify({ day_ids: dayIds }),
      });
      return await getTrip(tripId);
    } catch (e) { setError(e.message); return null; }
  }, [getTrip]);

  const deleteDay = useCallback(async (dayId, tripId) => {
    try {
      await _fetch(`/travel/days/${dayId}`, { method: 'DELETE' });
      return await getTrip(tripId);
    } catch (e) { setError(e.message); return null; }
  }, [getTrip]);

  // ── Places ───────────────────────────────────────────────────────────────

  const addPlace = useCallback(async (dayId, placeData, tripId) => {
    try {
      await _fetch(`/travel/days/${dayId}/places`, {
        method: 'POST',
        body: JSON.stringify(placeData),
      });
      return await getTrip(tripId);
    } catch (e) { setError(e.message); return null; }
  }, [getTrip]);

  const movePlace = useCallback(async (placeId, targetDayId, sortOrder, tripId) => {
    try {
      await _fetch(`/travel/places/${placeId}/move`, {
        method: 'PUT',
        body: JSON.stringify({ target_day_id: targetDayId, sort_order: sortOrder }),
      });
      return await getTrip(tripId);
    } catch (e) { setError(e.message); return null; }
  }, [getTrip]);

  const deletePlace = useCallback(async (placeId, tripId) => {
    try {
      await _fetch(`/travel/places/${placeId}`, { method: 'DELETE' });
      return await getTrip(tripId);
    } catch (e) { setError(e.message); return null; }
  }, [getTrip]);

  // ── Reservations ─────────────────────────────────────────────────────────

  const addReservation = useCallback(async (tripId, resData) => {
    try {
      await _fetch(`/travel/trips/${tripId}/reservations`, {
        method: 'POST',
        body: JSON.stringify(resData),
      });
      return await getTrip(tripId);
    } catch (e) { setError(e.message); return null; }
  }, [getTrip]);

  const deleteReservation = useCallback(async (resId, tripId) => {
    try {
      await _fetch(`/travel/reservations/${resId}`, { method: 'DELETE' });
      return await getTrip(tripId);
    } catch (e) { setError(e.message); return null; }
  }, [getTrip]);

  // ── Expenses & Budget ────────────────────────────────────────────────────

  const addExpense = useCallback(async (tripId, expenseData) => {
    try {
      await _fetch(`/travel/trips/${tripId}/expenses`, {
        method: 'POST',
        body: JSON.stringify(expenseData),
      });
      return await getTrip(tripId);
    } catch (e) { setError(e.message); return null; }
  }, [getTrip]);

  const getBudget = useCallback(async (tripId) => {
    try {
      return await _fetch(`/travel/trips/${tripId}/budget`);
    } catch (e) { setError(e.message); return null; }
  }, []);

  const deleteExpense = useCallback(async (expenseId, tripId) => {
    try {
      await _fetch(`/travel/expenses/${expenseId}`, { method: 'DELETE' });
      return await getTrip(tripId);
    } catch (e) { setError(e.message); return null; }
  }, [getTrip]);

  // ── Routing ──────────────────────────────────────────────────────────────

  const getRoute = useCallback(async (tripId) => {
    try {
      const data = await _fetch(`/travel/trips/${tripId}/route`);
      setRoute(data);
      return data;
    } catch (e) { setError(e.message); return null; }
  }, []);

  // ── POI Search ───────────────────────────────────────────────────────────

  const searchPlaces = useCallback(async ({ q = '', lat = 0, lon = 0, radius = 5000, category = '' } = {}) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (lat) params.set('lat', lat);
      if (lon) params.set('lon', lon);
      if (radius) params.set('radius', radius);
      if (category) params.set('category', category);
      const data = await _fetch(`/travel/places/search?${params}`);
      setSearchResults(data.places || []);
      setError(null);
      return data;
    } catch (e) { setError(e.message); return null; }
    finally { setLoading(false); }
  }, []);

  return {
    // State
    trips, activeTrip, route, searchResults, loading, error,
    // Trip CRUD
    listTrips, getTrip, createTrip, updateTrip, deleteTrip,
    // Days
    addDay, reorderDays, deleteDay,
    // Places
    addPlace, movePlace, deletePlace,
    // Reservations
    addReservation, deleteReservation,
    // Expenses
    addExpense, getBudget, deleteExpense,
    // Routing & Search
    getRoute, searchPlaces,
    // Setters
    setActiveTrip, setRoute,
  };
}
