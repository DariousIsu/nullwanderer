/**
 * AURA NX-Alpha — DetailPanel
 *
 * Shows context for the selected map location or satellite.
 * In trip mode, renders TripPlanner + PlaceSearch instead.
 */

import { useState } from 'react';
import TripPlanner from './TripPlanner';
import PlaceSearch from './PlaceSearch';
import styles from './DetailPanel.module.css';

export default function DetailPanel({
  location, satellite, loading, error,
  tripMode, travelData, mapCenter, onPlaceClick,
}) {
  const [showSearch, setShowSearch] = useState(false);

  // ── Trip mode: render TripPlanner + PlaceSearch ─────────────────────────
  if (tripMode && travelData) {
    return (
      <div className={styles.root}>
        <div className={styles.header}>
          <span>Trip Planner</span>
          <button
            className={styles.searchToggle}
            onClick={() => setShowSearch(v => !v)}
            title="Toggle place search"
          >
            {showSearch ? 'Itinerary' : 'Search'}
          </button>
        </div>
        <div className={styles.body}>
          {showSearch ? (
            <PlaceSearch
              travelData={travelData}
              mapCenter={mapCenter}
              onResultClick={onPlaceClick}
            />
          ) : (
            <TripPlanner
              travelData={travelData}
              onPlaceClick={onPlaceClick}
              onRouteRequest={(route) => travelData.setRoute(route)}
            />
          )}
        </div>
      </div>
    );
  }

  // ── Standard mode: location / satellite detail ──────────────────────────
  if (error) {
    return (
      <div className={styles.root}>
        <div className={styles.header}>Detail</div>
        <div className={styles.err}>Backend unavailable — {error}</div>
      </div>
    );
  }

  if (!location && !satellite) {
    return (
      <div className={styles.root}>
        <div className={styles.header}>Detail</div>
        <div className={styles.empty}>Select a location or satellite</div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        {satellite ? 'Satellite' : 'Location'}
      </div>

      <div className={styles.body}>
        {satellite && (
          <>
            <Row label="Name"     value={satellite.name} />
            <Row label="NORAD"    value={satellite.norad_id} />
            <Row label="Altitude" value={satellite.alt_km != null ? `${satellite.alt_km.toFixed(1)} km` : '—'} />
            <Row label="Lat"      value={satellite.lat  != null ? satellite.lat.toFixed(4)  : '—'} />
            <Row label="Lon"      value={satellite.lon  != null ? satellite.lon.toFixed(4)  : '—'} />
          </>
        )}
        {location && !satellite && (
          <>
            <Row label="Lat" value={location.lat.toFixed(6)} />
            <Row label="Lon" value={location.lon.toFixed(6)} />
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{value ?? '—'}</span>
    </div>
  );
}
