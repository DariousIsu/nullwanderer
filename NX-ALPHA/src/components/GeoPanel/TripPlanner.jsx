/**
 * AURA NX-Alpha — TripPlanner
 *
 * TREK-inspired itinerary sidebar for the GeoPanel.
 * Renders inside DetailPanel when in trip-planning mode.
 * Supports trip creation, day management, place adding, and reservations.
 */

import React, { useState, useEffect, useCallback } from 'react';
import styles from './TripPlanner.module.css';

export default function TripPlanner({ travelData, onPlaceClick, onRouteRequest }) {
  const {
    trips, activeTrip, loading, error,
    listTrips, getTrip, createTrip, updateTrip, deleteTrip,
    addDay, deleteDay,
    addPlace, deletePlace,
    addReservation, deleteReservation,
    addExpense, getBudget, deleteExpense,
    getRoute,
  } = travelData;

  const [view, setView]           = useState('list');  // list | trip | create
  const [newTrip, setNewTrip]     = useState({ name: '', destination: '', start_date: '', end_date: '' });
  const [budget, setBudget]       = useState(null);
  const [showAddRes, setShowAddRes] = useState(false);
  const [newRes, setNewRes]       = useState({ type: 'hotel', title: '', date: '' });
  const [showAddExp, setShowAddExp] = useState(false);
  const [newExp, setNewExp]       = useState({ description: '', amount: '', currency: 'USD', category: 'other' });

  useEffect(() => { listTrips(); }, [listTrips]);

  const handleCreateTrip = async () => {
    if (!newTrip.name) return;
    const trip = await createTrip(newTrip);
    if (trip) {
      setView('trip');
      setNewTrip({ name: '', destination: '', start_date: '', end_date: '' });
    }
  };

  const handleOpenTrip = async (tripId) => {
    await getTrip(tripId);
    setView('trip');
    setBudget(null);
  };

  const handleLoadBudget = async () => {
    if (!activeTrip) return;
    const b = await getBudget(activeTrip.id);
    setBudget(b);
  };

  const handleGetRoute = async () => {
    if (!activeTrip) return;
    const r = await getRoute(activeTrip.id);
    if (onRouteRequest && r) onRouteRequest(r);
  };

  const handleAddReservation = async () => {
    if (!activeTrip || !newRes.title) return;
    await addReservation(activeTrip.id, newRes);
    setShowAddRes(false);
    setNewRes({ type: 'hotel', title: '', date: '' });
  };

  const handleAddExpense = async () => {
    if (!activeTrip || !newExp.description || !newExp.amount) return;
    await addExpense(activeTrip.id, { ...newExp, amount: parseFloat(newExp.amount) });
    setShowAddExp(false);
    setNewExp({ description: '', amount: '', currency: 'USD', category: 'other' });
    handleLoadBudget();
  };

  // ── Trip List View ─────────────────────────────────────────────────────

  if (view === 'list') {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <h3 className={styles.title}>Trip Planner</h3>
          <button className={styles.btnPrimary} onClick={() => setView('create')}>+ New Trip</button>
        </div>

        {loading && <div className={styles.loading}>Loading trips...</div>}
        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.tripList}>
          {trips.map(trip => (
            <div key={trip.id} className={styles.tripCard} onClick={() => handleOpenTrip(trip.id)}>
              <div className={styles.tripName}>{trip.name}</div>
              <div className={styles.tripMeta}>
                {trip.destination && <span>{trip.destination}</span>}
                {trip.start_date && <span>{trip.start_date} — {trip.end_date}</span>}
              </div>
            </div>
          ))}
          {trips.length === 0 && !loading && (
            <div className={styles.empty}>No trips yet. Create one to get started.</div>
          )}
        </div>
      </div>
    );
  }

  // ── Create Trip View ───────────────────────────────────────────────────

  if (view === 'create') {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <button className={styles.btnBack} onClick={() => setView('list')}>Back</button>
          <h3 className={styles.title}>New Trip</h3>
        </div>

        <div className={styles.form}>
          <input
            className={styles.input}
            placeholder="Trip name"
            value={newTrip.name}
            onChange={e => setNewTrip({ ...newTrip, name: e.target.value })}
          />
          <input
            className={styles.input}
            placeholder="Destination"
            value={newTrip.destination}
            onChange={e => setNewTrip({ ...newTrip, destination: e.target.value })}
          />
          <div className={styles.dateRow}>
            <input
              className={styles.input}
              type="date"
              value={newTrip.start_date}
              onChange={e => setNewTrip({ ...newTrip, start_date: e.target.value })}
            />
            <input
              className={styles.input}
              type="date"
              value={newTrip.end_date}
              onChange={e => setNewTrip({ ...newTrip, end_date: e.target.value })}
            />
          </div>
          <button className={styles.btnPrimary} onClick={handleCreateTrip}>Create Trip</button>
        </div>
      </div>
    );
  }

  // ── Trip Detail View ───────────────────────────────────────────────────

  if (!activeTrip) return <div className={styles.loading}>Loading...</div>;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <button className={styles.btnBack} onClick={() => { setView('list'); setBudget(null); }}>Back</button>
        <h3 className={styles.title}>{activeTrip.name}</h3>
      </div>

      {activeTrip.destination && (
        <div className={styles.tripMeta}>{activeTrip.destination}</div>
      )}

      {/* Action buttons */}
      <div className={styles.actions}>
        <button className={styles.btnSmall} onClick={handleGetRoute}>Route</button>
        <button className={styles.btnSmall} onClick={handleLoadBudget}>Budget</button>
        <button className={styles.btnSmall} onClick={() => setShowAddRes(!showAddRes)}>+ Reservation</button>
        <button className={styles.btnSmall} onClick={() => setShowAddExp(!showAddExp)}>+ Expense</button>
      </div>

      {/* Budget Summary */}
      {budget && (
        <div className={styles.budgetBox}>
          <h4>Budget</h4>
          {Object.entries(budget.total_by_currency || {}).map(([curr, total]) => (
            <div key={curr} className={styles.budgetLine}>
              <span>{curr}</span>
              <span>{total.toFixed(2)}</span>
            </div>
          ))}
          {budget.count === 0 && <div className={styles.empty}>No expenses yet</div>}
        </div>
      )}

      {/* Add Reservation Form */}
      {showAddRes && (
        <div className={styles.inlineForm}>
          <select value={newRes.type} onChange={e => setNewRes({ ...newRes, type: e.target.value })}>
            <option value="flight">Flight</option>
            <option value="hotel">Hotel</option>
            <option value="restaurant">Restaurant</option>
            <option value="transport">Transport</option>
            <option value="activity">Activity</option>
            <option value="other">Other</option>
          </select>
          <input placeholder="Title" value={newRes.title} onChange={e => setNewRes({ ...newRes, title: e.target.value })} />
          <input type="date" value={newRes.date} onChange={e => setNewRes({ ...newRes, date: e.target.value })} />
          <button className={styles.btnPrimary} onClick={handleAddReservation}>Add</button>
        </div>
      )}

      {/* Add Expense Form */}
      {showAddExp && (
        <div className={styles.inlineForm}>
          <input placeholder="Description" value={newExp.description} onChange={e => setNewExp({ ...newExp, description: e.target.value })} />
          <input placeholder="Amount" type="number" value={newExp.amount} onChange={e => setNewExp({ ...newExp, amount: e.target.value })} />
          <input placeholder="USD" value={newExp.currency} onChange={e => setNewExp({ ...newExp, currency: e.target.value })} style={{ width: '60px' }} />
          <button className={styles.btnPrimary} onClick={handleAddExpense}>Add</button>
        </div>
      )}

      {/* Reservations */}
      {activeTrip.reservations?.length > 0 && (
        <div className={styles.section}>
          <h4>Reservations</h4>
          {activeTrip.reservations.map(res => (
            <div key={res.id} className={styles.resCard}>
              <span className={styles.resType}>{res.type}</span>
              <span className={styles.resTitle}>{res.title}</span>
              {res.date && <span className={styles.resDate}>{res.date}</span>}
              <button className={styles.btnDelete} onClick={() => deleteReservation(res.id, activeTrip.id)}>x</button>
            </div>
          ))}
        </div>
      )}

      {/* Itinerary — Days & Places */}
      <div className={styles.section}>
        <h4>Itinerary</h4>
        {(activeTrip.days || []).map(day => (
          <div key={day.id} className={styles.dayBlock}>
            <div className={styles.dayHeader}>
              <span className={styles.dayLabel}>{day.label || day.date}</span>
              <span className={styles.dayDate}>{day.date}</span>
              <button className={styles.btnDelete} onClick={() => deleteDay(day.id, activeTrip.id)}>x</button>
            </div>
            <div className={styles.placeList}>
              {(day.places || []).map((place, idx) => (
                <div
                  key={place.id}
                  className={styles.placeCard}
                  onClick={() => onPlaceClick && onPlaceClick(place)}
                >
                  <span className={styles.placeNum}>{idx + 1}</span>
                  <div className={styles.placeInfo}>
                    <div className={styles.placeName}>{place.name}</div>
                    <div className={styles.placeCat}>{place.category}</div>
                  </div>
                  <button className={styles.btnDelete} onClick={e => { e.stopPropagation(); deletePlace(place.id, activeTrip.id); }}>x</button>
                </div>
              ))}
              {(day.places || []).length === 0 && (
                <div className={styles.emptyPlace}>No places — search and add from map</div>
              )}
            </div>
          </div>
        ))}
        {(activeTrip.days || []).length === 0 && (
          <div className={styles.empty}>No days in this trip</div>
        )}
      </div>

      {/* Delete Trip */}
      <button
        className={styles.btnDanger}
        onClick={async () => { if (confirm('Delete this trip?')) { await deleteTrip(activeTrip.id); setView('list'); } }}
      >
        Delete Trip
      </button>
    </div>
  );
}
