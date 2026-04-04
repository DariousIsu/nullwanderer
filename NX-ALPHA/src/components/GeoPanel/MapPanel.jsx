/**
 * AURA NX-Alpha — MapPanel
 *
 * MapLibre GL JS map with:
 *  - Switchable basemap: Street (OSM) | Satellite (Esri) | Hybrid (Esri + labels)
 *  - NASA GIBS WMS overlay (toggled from LayerControlPanel)
 *  - Crisis event markers (GDACS + USGS, color-coded by alert level)
 *  - Satellite position markers (from orbital service, 30s poll)
 *  - Ground track line on satellite click
 *  - Event popup on event click
 *  - Geocoder search bar overlay
 *  - Trip waypoint markers and route polyline (trip mode)
 */

import { useRef, useEffect, useState, useCallback } from 'react';
import Map, { Source, Layer, Marker, NavigationControl, Popup } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import styles from './MapPanel.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// BASEMAP STYLES — no API key required
// ─────────────────────────────────────────────────────────────────────────────

const ESRI_SAT_SOURCE = {
  type:        'raster',
  tiles:       ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
  tileSize:    256,
  attribution: 'Tiles © Esri — Esri, i-cubed, USDA, USGS, GeoEye, Getmapping, Aerogrid, IGN',
};

const ESRI_LABELS_SOURCE = {
  type:     'raster',
  tiles:    ['https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
  tileSize: 256,
};

const BASEMAP_STYLES = {
  street: {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      osm: {
        type:        'raster',
        tiles:       ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize:    256,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
    layers: [{ id: 'osm-tiles', type: 'raster', source: 'osm', minzoom: 0, maxzoom: 19 }],
  },
  satellite: {
    version: 8,
    sources: { esri_sat: ESRI_SAT_SOURCE },
    layers:  [{ id: 'esri-sat', type: 'raster', source: 'esri_sat' }],
  },
  hybrid: {
    version: 8,
    sources: { esri_sat: ESRI_SAT_SOURCE, esri_labels: ESRI_LABELS_SOURCE },
    layers: [
      { id: 'esri-sat',    type: 'raster', source: 'esri_sat' },
      { id: 'esri-labels', type: 'raster', source: 'esri_labels', paint: { 'raster-opacity': 0.9 } },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// LAYER STYLES
// ─────────────────────────────────────────────────────────────────────────────

const TRACK_LINE_LAYER = {
  id:   'ground-track-line',
  type: 'line',
  paint: {
    'line-color':     '#f5a623',
    'line-width':     1.5,
    'line-opacity':   0.8,
    'line-dasharray': [4, 2],
  },
};

const SATELLITE_CIRCLE_LAYER = {
  id:   'satellites-circle',
  type: 'circle',
  paint: {
    'circle-radius':       4,
    'circle-color':        '#00d4ff',
    'circle-opacity':      0.9,
    'circle-stroke-width': 1,
    'circle-stroke-color': '#ffffff',
  },
};

const EVENTS_CIRCLE_LAYER = {
  id:   'events-circle',
  type: 'circle',
  paint: {
    'circle-radius': [
      'interpolate', ['linear'], ['zoom'],
      2, 5,
      8, 10,
    ],
    'circle-color': [
      'match', ['get', 'alert'],
      'Red',    '#ef4444',
      'Orange', '#f97316',
      '#fbbf24',
    ],
    'circle-opacity':      0.88,
    'circle-stroke-width': 1.5,
    'circle-stroke-color': 'rgba(0,0,0,0.45)',
  },
};

const TRIP_ROUTE_LAYER = {
  id:   'trip-route-line',
  type: 'line',
  paint: {
    'line-color':   '#60a5fa',
    'line-width':   3,
    'line-opacity': 0.8,
  },
};

const TRIP_WAYPOINTS_LAYER = {
  id:   'trip-waypoints',
  type: 'circle',
  paint: {
    'circle-radius':       7,
    'circle-color':        '#4ade80',
    'circle-opacity':      0.95,
    'circle-stroke-width': 2,
    'circle-stroke-color': '#ffffff',
  },
};

// Alert level → display color (for popup badge)
const ALERT_COLOR = { Red: '#ef4444', Orange: '#f97316', Green: '#4ade80' };

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function MapPanel({
  satellites        = [],
  activeGIBSLayer   = null,
  selectedSatellite = null,
  onLocationClick,
  onSatelliteClick,
  getGroundTrack,
  events            = [],
  showEvents        = true,
  geocode,
  basemap           = 'street',
  tripMode          = false,
  tripWaypoints     = [],
  tripRoute         = null,
  onMapMove,
  flyToLocation     = null,
}) {
  const mapRef       = useRef(null);
  const [groundTrack,  setGroundTrack]  = useState(null);
  const [popupEvent,   setPopupEvent]   = useState(null);
  const [searchQuery,  setSearchQuery]  = useState('');
  const [searching,    setSearching]    = useState(false);
  const [searchError,  setSearchError]  = useState('');

  // ── Fetch ground track when satellite selected ───────────────────────────
  useEffect(() => {
    if (!selectedSatellite || !getGroundTrack) {
      setGroundTrack(null);
      return;
    }
    getGroundTrack(selectedSatellite.norad_id)
      .then(feature => setGroundTrack(feature.geometry ?? null))
      .catch(() => setGroundTrack(null));
  }, [selectedSatellite, getGroundTrack]);

  // ── Fly to location when requested ──────────────────────────────────────
  useEffect(() => {
    if (!flyToLocation) return;
    mapRef.current?.getMap?.().flyTo({
      center: [flyToLocation.lon, flyToLocation.lat],
      zoom: 14,
      speed: 1.6,
    });
  }, [flyToLocation]);

  // ── Report map center on move (for POI search) ─────────────────────────
  const handleMoveEnd = useCallback(() => {
    if (!onMapMove) return;
    const map = mapRef.current?.getMap?.();
    if (!map) return;
    const center = map.getCenter();
    onMapMove({ lat: center.lat, lon: center.lng });
  }, [onMapMove]);

  // ── Build GeoJSON for satellite positions ────────────────────────────────
  const satelliteGeoJSON = {
    type: 'FeatureCollection',
    features: satellites.map(sat => ({
      type: 'Feature',
      geometry:   { type: 'Point', coordinates: [sat.lon, sat.lat] },
      properties: { norad_id: sat.norad_id, name: sat.name, alt_km: sat.alt_km },
    })),
  };

  // ── Build GeoJSON for crisis events ─────────────────────────────────────
  const eventsGeoJSON = {
    type: 'FeatureCollection',
    features: events.map(ev => ({
      type: 'Feature',
      geometry:   { type: 'Point', coordinates: [ev.lon, ev.lat] },
      properties: {
        id:      ev.id,
        source:  ev.source,
        type:    ev.type,
        name:    ev.name,
        country: ev.country,
        alert:   ev.alert,
        date:    ev.date,
        url:     ev.url,
        mag:     ev.mag ?? null,
      },
    })),
  };

  // ── Build GeoJSON for trip waypoints ────────────────────────────────────
  const waypointsGeoJSON = {
    type: 'FeatureCollection',
    features: tripWaypoints.map((wp, i) => ({
      type: 'Feature',
      geometry:   { type: 'Point', coordinates: [wp.lon, wp.lat] },
      properties: { name: wp.name, dayLabel: wp.dayLabel, idx: i + 1 },
    })),
  };

  // ── Build GeoJSON for trip route ────────────────────────────────────────
  const routeGeoJSON = tripRoute?.geometry
    ? { type: 'Feature', geometry: tripRoute.geometry, properties: {} }
    : tripRoute?.type === 'FeatureCollection'
      ? tripRoute
      : null;

  // ── GIBS WMS source spec ─────────────────────────────────────────────────
  const gibsSource = activeGIBSLayer ? {
    type:  'raster',
    tiles: [
      `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi` +
      `?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap` +
      `&LAYERS=${activeGIBSLayer}` +
      `&CRS=EPSG:4326&WIDTH=256&HEIGHT=256` +
      `&FORMAT=image/png&TRANSPARENT=true` +
      `&BBOX={bbox-epsg-4326}`,
    ],
    tileSize: 256,
  } : null;

  // ── Map click — events first, then satellites, then location ────────────
  const handleMapClick = useCallback((e) => {
    const map = mapRef.current?.getMap?.();
    if (!map) return;

    // Events layer
    if (showEvents) {
      const evtFeatures = map.queryRenderedFeatures(e.point, { layers: ['events-circle'] });
      if (evtFeatures.length > 0) {
        const p = evtFeatures[0].properties;
        setPopupEvent({ ...p, lon: evtFeatures[0].geometry.coordinates[0], lat: evtFeatures[0].geometry.coordinates[1] });
        return;
      }
    }

    // Satellite layer
    const satFeatures = map.queryRenderedFeatures(e.point, { layers: ['satellites-circle'] });
    if (satFeatures.length > 0) {
      const props = satFeatures[0].properties;
      onSatelliteClick?.({ norad_id: props.norad_id, name: props.name, alt_km: props.alt_km });
      return;
    }

    setPopupEvent(null);
    onLocationClick?.({ lat: e.lngLat.lat, lon: e.lngLat.lng });
  }, [onLocationClick, onSatelliteClick, showEvents]);

  // ── Geocoder search ──────────────────────────────────────────────────────
  const handleSearch = useCallback(async (e) => {
    e.preventDefault();
    if (!geocode || !searchQuery.trim()) return;
    setSearching(true);
    setSearchError('');
    try {
      const results = await geocode(searchQuery.trim());
      if (!results || results.length === 0) {
        setSearchError('No results');
        return;
      }
      const { lat, lon } = results[0];
      mapRef.current?.getMap?.().flyTo({
        center: [parseFloat(lon), parseFloat(lat)],
        zoom:   10,
        speed:  1.4,
      });
      setSearchQuery('');
    } catch {
      setSearchError('Search failed');
    } finally {
      setSearching(false);
    }
  }, [geocode, searchQuery]);

  return (
    <div className={styles.root}>
      <Map
        ref={mapRef}
        initialViewState={{ longitude: 10, latitude: 20, zoom: 2 }}
        style={{ width: '100%', height: '100%' }}
        mapStyle={BASEMAP_STYLES[basemap] ?? BASEMAP_STYLES.street}
        onClick={handleMapClick}
        onMoveEnd={handleMoveEnd}
        cursor="crosshair"
        attributionControl={false}
      >
        <NavigationControl position="top-right" />

        {/* ── NASA GIBS WMS overlay ── */}
        {activeGIBSLayer && gibsSource && (
          <>
            <Source id="gibs-wms" {...gibsSource} />
            <Layer
              id="gibs-layer"
              type="raster"
              source="gibs-wms"
              paint={{ 'raster-opacity': 0.75 }}
            />
          </>
        )}

        {/* ── Crisis events layer ── */}
        {showEvents && (
          <>
            <Source id="events" type="geojson" data={eventsGeoJSON} />
            <Layer {...EVENTS_CIRCLE_LAYER} source="events" />
          </>
        )}

        {/* ── Satellite positions (circle layer) ── */}
        <Source id="satellites" type="geojson" data={satelliteGeoJSON} />
        <Layer {...SATELLITE_CIRCLE_LAYER} source="satellites" />

        {/* ── Ground track for selected satellite ── */}
        {groundTrack && (
          <>
            <Source
              id="ground-track"
              type="geojson"
              data={{ type: 'Feature', geometry: groundTrack, properties: {} }}
            />
            <Layer {...TRACK_LINE_LAYER} source="ground-track" />
          </>
        )}

        {/* ── Trip route polyline ── */}
        {tripMode && routeGeoJSON && (
          <>
            <Source id="trip-route" type="geojson" data={routeGeoJSON} />
            <Layer {...TRIP_ROUTE_LAYER} source="trip-route" />
          </>
        )}

        {/* ── Trip waypoint markers ── */}
        {tripMode && tripWaypoints.length > 0 && (
          <>
            <Source id="trip-waypoints" type="geojson" data={waypointsGeoJSON} />
            <Layer {...TRIP_WAYPOINTS_LAYER} source="trip-waypoints" />
          </>
        )}

        {/* ── Trip waypoint numbered labels (HTML markers for numbering) ── */}
        {tripMode && tripWaypoints.map((wp, i) => (
          <Marker
            key={`trip-wp-${wp.id || i}`}
            longitude={wp.lon}
            latitude={wp.lat}
            anchor="center"
          >
            <div className={styles.tripMarker} title={`${wp.dayLabel}: ${wp.name}`}>
              {i + 1}
            </div>
          </Marker>
        ))}

        {/* ── Selected satellite highlight ── */}
        {selectedSatellite && (
          <Marker
            longitude={selectedSatellite.lon}
            latitude={selectedSatellite.lat}
            anchor="center"
          >
            <div className={styles.selectedMarker} title={selectedSatellite.name} />
          </Marker>
        )}

        {/* ── Event popup ── */}
        {popupEvent && (
          <Popup
            longitude={popupEvent.lon}
            latitude={popupEvent.lat}
            anchor="bottom"
            onClose={() => setPopupEvent(null)}
            closeOnClick={false}
            maxWidth="280px"
          >
            <div className={styles.popup}>
              <div className={styles.popupHeader}>
                <span
                  className={styles.popupAlert}
                  style={{ background: ALERT_COLOR[popupEvent.alert] ?? '#fbbf24' }}
                >
                  {popupEvent.alert}
                </span>
                <span className={styles.popupSource}>{popupEvent.source} · {popupEvent.type}</span>
              </div>
              <div className={styles.popupName}>{popupEvent.name}</div>
              {popupEvent.country && (
                <div className={styles.popupMeta}>{popupEvent.country}</div>
              )}
              {popupEvent.mag != null && (
                <div className={styles.popupMeta}>Magnitude {popupEvent.mag}</div>
              )}
              {popupEvent.date && (
                <div className={styles.popupMeta}>{popupEvent.date.split('T')[0]}</div>
              )}
              {popupEvent.url && (
                <a
                  className={styles.popupLink}
                  href={popupEvent.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  View Report ↗
                </a>
              )}
            </div>
          </Popup>
        )}
      </Map>

      {/* ── Geocoder search bar ── */}
      <form className={styles.searchBar} onSubmit={handleSearch}>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Search location…"
          value={searchQuery}
          onChange={e => { setSearchQuery(e.target.value); setSearchError(''); }}
          aria-label="Geocoder search"
        />
        <button className={styles.searchBtn} type="submit" disabled={searching}>
          {searching ? '…' : '⌕'}
        </button>
        {searchError && <span className={styles.searchError}>{searchError}</span>}
      </form>

      {/* ── Satellite count badge ── */}
      {satellites.length > 0 && (
        <div className={styles.badge}>{satellites.length} objects</div>
      )}

      {/* ── Trip waypoint count badge ── */}
      {tripMode && tripWaypoints.length > 0 && (
        <div className={styles.tripBadge}>{tripWaypoints.length} waypoints</div>
      )}
    </div>
  );
}
