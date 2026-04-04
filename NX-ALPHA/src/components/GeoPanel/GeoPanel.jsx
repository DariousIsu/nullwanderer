/**
 * AURA NX-Alpha — GeoPanel
 *
 * Geospatial Intelligence Panel — Phase 7.
 *
 * LAYOUT (fixed flex — no react-grid-layout):
 *   ┌──────────────────────┬────────────┐
 *   │                      │ StreetView │  ← flex row, map gets flex:1
 *   │      MapPanel        ├────────────┤
 *   │   (MapLibre GL)      │Detail/Trip │
 *   ├──────────────────────┴────────────┤
 *   │          LayerControlPanel        │  ← fixed-height strip
 *   └───────────────────────────────────┘
 *
 * DATA: useGeo() — satellites (30s poll), GIBS layers, geocode, ground track
 *       useTravelData() — trips, itinerary, POI search, routing (trip mode)
 */

import { useState, useCallback } from 'react';
import { useGeo } from '../../hooks/useGeo';
import { useTravelData } from '../../hooks/useTravelData';
import MapPanel from './MapPanel';
import StreetViewPanel from './StreetViewPanel';
import DetailPanel from './DetailPanel';
import LayerControlPanel from './LayerControlPanel';
import styles from './GeoPanel.module.css';

export default function GeoPanel() {
  const [selectedLocation,  setSelectedLocation]  = useState(null);
  const [selectedSatellite, setSelectedSatellite] = useState(null);
  const [activeGIBSLayer,   setActiveGIBSLayer]   = useState(null);
  const [category,          setCategory]          = useState('active');
  const [showEvents,        setShowEvents]        = useState(true);
  const [basemap,           setBasemap]           = useState('street');
  const [tripMode,          setTripMode]          = useState(false);
  const [mapCenter,         setMapCenter]         = useState({ lat: 20, lon: 10 });

  const { satellites, gibsLayers, events, loading, error, geocode, getGroundTrack, refreshTLE } = useGeo(category);
  const travelData = useTravelData();

  // Called when user clicks a search result or itinerary place — fly map to it
  const handlePlaceClick = useCallback((place) => {
    setSelectedLocation({ lat: place.lat, lon: place.lon ?? place.lng, flyTo: true });
  }, []);

  // Called when MapPanel viewport moves — track center for POI search
  const handleMapMove = useCallback((center) => {
    setMapCenter(center);
  }, []);

  // Collect trip waypoints for map markers
  const tripWaypoints = tripMode && travelData.activeTrip?.days
    ? travelData.activeTrip.days.flatMap(day =>
        (day.places || []).map((p, idx) => ({ ...p, dayLabel: day.label || day.date, idx }))
      )
    : [];

  return (
    <div className={styles.root}>
      {/* ── MAIN WORKSPACE ─────────────────────────────────────────────── */}
      <div className={styles.workspace}>

        {/* ── MAP — takes all remaining horizontal space ── */}
        <div className={styles.mapArea}>
          <MapPanel
            satellites={satellites}
            activeGIBSLayer={activeGIBSLayer}
            selectedSatellite={selectedSatellite}
            onLocationClick={setSelectedLocation}
            onSatelliteClick={setSelectedSatellite}
            getGroundTrack={getGroundTrack}
            events={events}
            showEvents={showEvents}
            geocode={geocode}
            basemap={basemap}
            tripMode={tripMode}
            tripWaypoints={tripWaypoints}
            tripRoute={travelData.route}
            onMapMove={handleMapMove}
            flyToLocation={selectedLocation?.flyTo ? selectedLocation : null}
          />
        </div>

        {/* ── RIGHT COLUMN — StreetView on top, Detail/Trip below ── */}
        <div className={styles.rightCol}>
          <div className={tripMode ? styles.streetViewAreaCollapsed : styles.streetViewArea}>
            <StreetViewPanel location={selectedLocation} />
          </div>
          <div className={tripMode ? styles.detailAreaExpanded : styles.detailArea}>
            <DetailPanel
              location={selectedLocation}
              satellite={selectedSatellite}
              loading={loading}
              error={error}
              tripMode={tripMode}
              travelData={travelData}
              mapCenter={mapCenter}
              onPlaceClick={handlePlaceClick}
            />
          </div>
        </div>

      </div>

      {/* ── LAYER CONTROLS — full-width strip at bottom ────────────────── */}
      <div className={styles.layerBar}>
        <LayerControlPanel
          gibsLayers={gibsLayers}
          activeGIBSLayer={activeGIBSLayer}
          onGIBSLayerChange={setActiveGIBSLayer}
          category={category}
          onCategoryChange={setCategory}
          onRefreshTLE={() => refreshTLE(category)}
          showEvents={showEvents}
          onEventsToggle={() => setShowEvents(v => !v)}
          eventCount={events.length}
          basemap={basemap}
          onBasemapChange={setBasemap}
          tripMode={tripMode}
          onTripModeToggle={() => setTripMode(v => !v)}
        />
      </div>
    </div>
  );
}
