/**
 * AURA NX-Alpha — PlaceSearch
 *
 * POI search overlay for the GeoPanel map. Searches for nearby
 * restaurants, hotels, attractions, etc. using the Overpass API.
 * Results can be added to any trip day.
 */

import React, { useState, useCallback } from 'react';
import styles from './PlaceSearch.module.css';

const CATEGORIES = [
  { value: '', label: 'All' },
  { value: 'restaurant', label: 'Restaurants' },
  { value: 'hotel', label: 'Hotels' },
  { value: 'cafe', label: 'Cafes' },
  { value: 'museum', label: 'Museums' },
  { value: 'attraction', label: 'Attractions' },
  { value: 'park', label: 'Parks' },
  { value: 'shopping', label: 'Shopping' },
  { value: 'bar', label: 'Bars' },
  { value: 'transport', label: 'Transport' },
];

export default function PlaceSearch({
  travelData,
  mapCenter,       // { lat, lon } from current map viewport
  onResultClick,   // called when user clicks a search result
}) {
  const { searchPlaces, searchResults, loading, activeTrip, addPlace } = travelData;

  const [query, setQuery]       = useState('');
  const [category, setCategory] = useState('');
  const [radius, setRadius]     = useState(5000);

  const handleSearch = useCallback(async () => {
    const lat = mapCenter?.lat || 0;
    const lon = mapCenter?.lon || mapCenter?.lng || 0;
    await searchPlaces({ q: query, lat, lon, radius, category });
  }, [searchPlaces, query, category, radius, mapCenter]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSearch();
  };

  const handleAddToTrip = async (place, dayId) => {
    if (!activeTrip) return;
    await addPlace(dayId, {
      name: place.name,
      lat: place.lat,
      lon: place.lon,
      category: place.category || 'other',
      address: place.address || '',
    }, activeTrip.id);
  };

  return (
    <div className={styles.container}>
      <div className={styles.searchBar}>
        <input
          className={styles.input}
          placeholder="Search places..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <select
          className={styles.select}
          value={category}
          onChange={e => setCategory(e.target.value)}
        >
          {CATEGORIES.map(c => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        <button className={styles.btnSearch} onClick={handleSearch} disabled={loading}>
          {loading ? '...' : 'Search'}
        </button>
      </div>

      <div className={styles.results}>
        {searchResults.map((place, idx) => (
          <div
            key={`${place.lat}-${place.lon}-${idx}`}
            className={styles.resultCard}
            onClick={() => onResultClick && onResultClick(place)}
          >
            <div className={styles.resultInfo}>
              <div className={styles.resultName}>{place.name}</div>
              <div className={styles.resultMeta}>
                {place.category && <span className={styles.resultCat}>{place.category}</span>}
                {place.address && <span className={styles.resultAddr}>{place.address}</span>}
              </div>
              {place.opening_hours && (
                <div className={styles.resultHours}>{place.opening_hours}</div>
              )}
            </div>
            {activeTrip && activeTrip.days?.length > 0 && (
              <div className={styles.addActions}>
                {activeTrip.days.map(day => (
                  <button
                    key={day.id}
                    className={styles.btnAddDay}
                    onClick={e => { e.stopPropagation(); handleAddToTrip(place, day.id); }}
                    title={`Add to ${day.label || day.date}`}
                  >
                    {day.label || day.date}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {searchResults.length === 0 && !loading && (
          <div className={styles.empty}>
            Search for places near the map center
          </div>
        )}
      </div>
    </div>
  );
}
