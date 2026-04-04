/**
 * AURA NX-Alpha — useGeo hook
 *
 * Fetches satellite positions and GIBS layer catalogue from the geo backend.
 * Exposes geocode() for search-by-query.
 *
 * Satellites are polled every 30 seconds while the hook is mounted —
 * orbital periods are typically 90–100 min so 30s is a reasonable refresh.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

const API = 'http://localhost:8000';
const SATELLITE_POLL_MS = 30_000;
const EVENTS_POLL_MS    = 300_000; // 5 minutes

export function useGeo(satelliteCategory = 'active') {
  const [satellites,  setSatellites]  = useState([]);
  const [gibsLayers,  setGibsLayers]  = useState([]);
  const [events,      setEvents]      = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const pollRef       = useRef(null);
  const eventsPollRef = useRef(null);

  // ── Initial data load ────────────────────────────────────────────────────
  useEffect(() => {
    // GIBS layers are static — fetch once
    fetch(`${API}/geo/imagery/gibs/layers`)
      .then(r => r.json())
      .then(setGibsLayers)
      .catch(() => {});

    // Satellites: fetch immediately, then poll
    const fetchSatellites = () =>
      fetch(`${API}/geo/satellites?category=${satelliteCategory}`)
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then(data => {
          setSatellites(data);
          setLoading(false);
          setError(null);
        })
        .catch(err => {
          setError(err.message);
          setLoading(false);
        });

    // Events: fetch immediately, then poll every 5 min
    const fetchEvents = () =>
      fetch(`${API}/geo/events`)
        .then(r => r.ok ? r.json() : [])
        .then(setEvents)
        .catch(() => {});

    fetchSatellites();
    fetchEvents();
    pollRef.current      = setInterval(fetchSatellites, SATELLITE_POLL_MS);
    eventsPollRef.current = setInterval(fetchEvents, EVENTS_POLL_MS);

    return () => {
      if (pollRef.current)       clearInterval(pollRef.current);
      if (eventsPollRef.current) clearInterval(eventsPollRef.current);
    };
  }, [satelliteCategory]);

  // ── Geocode ──────────────────────────────────────────────────────────────
  const geocode = useCallback(async (query) => {
    const res = await fetch(`${API}/geo/geocode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query }),
    });
    if (!res.ok) throw new Error(`Geocode failed: HTTP ${res.status}`);
    return res.json();
  }, []);

  // ── Ground track ─────────────────────────────────────────────────────────
  const getGroundTrack = useCallback(async (noradId, hours = 2.0) => {
    const res = await fetch(
      `${API}/geo/satellites/${noradId}/track?hours=${hours}`
    );
    if (!res.ok) throw new Error(`Track fetch failed: HTTP ${res.status}`);
    return res.json(); // GeoJSON Feature
  }, []);

  // ── Force TLE refresh ────────────────────────────────────────────────────
  const refreshTLE = useCallback(async (category = 'active') => {
    const res = await fetch(`${API}/geo/tle/refresh?category=${category}`);
    if (!res.ok) throw new Error(`TLE refresh failed: HTTP ${res.status}`);
    return res.json();
  }, []);

  return { satellites, gibsLayers, events, loading, error, geocode, getGroundTrack, refreshTLE };
}
