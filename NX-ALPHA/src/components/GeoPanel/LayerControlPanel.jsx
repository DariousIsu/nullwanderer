/**
 * AURA NX-Alpha — LayerControlPanel (stub)
 *
 * Full-width strip at the bottom of GeoPanel.
 * Controls: NASA GIBS satellite layer toggle, TLE category selector, refresh button.
 * Future: historical maps (AllMaps), Space Mode (Cesium), opacity sliders.
 */

import styles from './LayerControlPanel.module.css';

const CATEGORIES = [
  { id: 'active',   label: 'Active' },
  { id: 'stations', label: 'ISS/Stations' },
  { id: 'starlink', label: 'Starlink' },
  { id: 'weather',  label: 'Weather' },
  { id: 'amateur',  label: 'Amateur' },
  { id: 'debris',   label: 'Debris' },
];

const BASEMAPS = [
  { id: 'street',    label: 'Street' },
  { id: 'satellite', label: 'Satellite' },
  { id: 'hybrid',    label: 'Hybrid' },
];

export default function LayerControlPanel({
  gibsLayers      = [],
  activeGIBSLayer = null,
  onGIBSLayerChange,
  category        = 'active',
  onCategoryChange,
  onRefreshTLE,
  showEvents      = true,
  onEventsToggle,
  eventCount      = 0,
  basemap         = 'street',
  onBasemapChange,
  tripMode        = false,
  onTripModeToggle,
}) {
  const handleGIBSToggle = (layerId) => {
    onGIBSLayerChange?.(activeGIBSLayer === layerId ? null : layerId);
  };

  return (
    <div className={styles.root}>

      {/* ── Basemap selector ───────────────────────────────────────────── */}
      <div className={styles.group}>
        <span className={styles.groupLabel}>Basemap</span>
        <div className={styles.pills}>
          {BASEMAPS.map(b => (
            <button
              key={b.id}
              className={[styles.pill, basemap === b.id && styles.pillActive].filter(Boolean).join(' ')}
              onClick={() => onBasemapChange?.(b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.divider} />

      {/* ── Satellite category selector ─────────────────────────────────── */}
      <div className={styles.group}>
        <span className={styles.groupLabel}>Catalog</span>
        <div className={styles.pills}>
          {CATEGORIES.map(cat => (
            <button
              key={cat.id}
              className={[styles.pill, category === cat.id && styles.pillActive].filter(Boolean).join(' ')}
              onClick={() => onCategoryChange?.(cat.id)}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.divider} />

      {/* ── NASA GIBS layer picker ──────────────────────────────────────── */}
      <div className={styles.group}>
        <span className={styles.groupLabel}>GIBS Layer</span>
        <div className={styles.pills}>
          {gibsLayers.map(layer => (
            <button
              key={layer.id}
              className={[styles.pill, activeGIBSLayer === layer.id && styles.pillActive].filter(Boolean).join(' ')}
              onClick={() => handleGIBSToggle(layer.id)}
              title={layer.description}
            >
              {layer.name.replace('MODIS Terra — ', '').replace('VIIRS SNPP — ', '').replace('VIIRS — ', '')}
            </button>
          ))}
          {gibsLayers.length === 0 && (
            <span className={styles.empty}>Loading layers…</span>
          )}
        </div>
      </div>

      <div className={styles.divider} />

      {/* ── Crisis events toggle ───────────────────────────────────────── */}
      <div className={styles.group}>
        <span className={styles.groupLabel}>Events</span>
        <div className={styles.pills}>
          <button
            className={[styles.pill, showEvents && styles.pillActive].filter(Boolean).join(' ')}
            onClick={onEventsToggle}
            title="Toggle GDACS + USGS crisis event markers"
          >
            {showEvents ? `Crisis Events (${eventCount})` : 'Events Hidden'}
          </button>
        </div>
      </div>

      <div className={styles.divider} />

      {/* ── Trip mode toggle ──────────────────────────────────────────── */}
      <div className={styles.group}>
        <span className={styles.groupLabel}>Travel</span>
        <div className={styles.pills}>
          <button
            className={[styles.pill, tripMode && styles.pillTrip].filter(Boolean).join(' ')}
            onClick={onTripModeToggle}
            title="Toggle trip planner mode"
          >
            {tripMode ? 'Trip Mode ON' : 'Trip Mode'}
          </button>
        </div>
      </div>

      <div className={styles.divider} />

      {/* ── TLE refresh ────────────────────────────────────────────────── */}
      <button className={styles.refreshBtn} onClick={onRefreshTLE} title="Force TLE refresh from CelesTrak">
        ↻ Refresh TLE
      </button>

    </div>
  );
}
