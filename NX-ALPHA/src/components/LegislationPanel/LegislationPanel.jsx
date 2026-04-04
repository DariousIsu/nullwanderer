/**
 * AURA NX-Alpha — LegislationPanel
 *
 * Full-canvas panel for browsing 50-state active legislative sessions.
 * Mounted inside DropPanel when id='legislation'.
 *
 * LAYOUT:
 *   ┌─────────────────┬───────────────────────────────┬──────────────────┐
 *   │   SIDEBAR       │   MAIN                        │   BILL DETAIL    │
 *   │   220px         │   flex:1                      │   400px          │
 *   │                 │                               │                  │
 *   │  [Search]       │  State — Session  [Context ▼] │  HB 42  [status] │
 *   │  ───────        │  [House][Senate][Reconciled]  │  ─────────────── │
 *   │  Alabama        │  [Active][Pending][Passed]    │  Full title…     │
 *   │  2026 Regular   │  [Dropped]                    │  Subjects        │
 *   │  ───────        │  ─────────────────────────── │  Sponsors        │
 *   │  Alaska         │  HB 42  [active]  2026-03-29 │  Abstract        │
 *   │  ...            │  Appropriations Act…          │  Actions         │
 *   │                 │  SB 7   [passed]  2026-03-15 │  Sources         │
 *   │  [import …]     │  ...                          │  AI Commentary   │
 *   └─────────────────┴───────────────────────────────┴──────────────────┘
 *
 * CONTEXTS:
 *   Personal — policy research framing (default)
 *   Client   — Gleipnir consulting framing
 *   Context selector is a dropdown in the main header.
 *   It tags commentary POST requests only — no bill filtering.
 *
 * @param {function} onOpenPanel — (id: string) => void — opens another drop panel
 *                                 Used by BillDetail to navigate to Agent Creator.
 */
import { useState } from 'react';
import LegislationSidebar from './LegislationSidebar';
import BillList           from './BillList';
import BillDetail         from './BillDetail';
import { useLegislation } from '../../hooks/useLegislation';
import styles             from './LegislationPanel.module.css';

// ── CHAMBER + STATUS CONFIG ───────────────────────────────────────────────────

const CHAMBERS = [
  { id: 'house',       label: 'House'       },
  { id: 'senate',      label: 'Senate'      },
  { id: 'reconciled',  label: 'Reconciled'  },
];

const STATUSES = [
  { id: 'active',  label: 'Active'  },
  { id: 'pending', label: 'Pending' },
  { id: 'passed',  label: 'Passed'  },
  { id: 'dropped', label: 'Dropped' },
];

const STATUS_CHIP_CLASS = {
  active:  styles.chipActive,
  pending: styles.chipPending,
  passed:  styles.chipPassed,
  dropped: styles.chipDropped,
};

// ── COMPONENT ─────────────────────────────────────────────────────────────────

export default function LegislationPanel({ onOpenPanel }) {
  const [selectedState,    setSelectedState]    = useState(null);
  const [selectedChamber,  setSelectedChamber]  = useState('house');
  const [selectedStatuses, setSelectedStatuses] = useState(['active', 'pending', 'passed', 'dropped']);
  const [selectedBill,     setSelectedBill]     = useState(null);
  const [context,          setContext]          = useState('personal');

  const {
    states,
    importStatus,
    bills,
    billDetail,
    searchQuery,
    setSearchQuery,
    requestCommentary,
    commentaryLoading,
    commentaryTokens,
    requestDeepResearch,
  } = useLegislation(selectedState, selectedChamber, selectedStatuses, selectedBill);

  function toggleStatus(id) {
    setSelectedStatuses(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }

  function handleSelectBill(bill) {
    // Clear commentary when switching bills
    setSelectedBill(prev => prev?.id === bill.id ? null : bill);
  }

  function handleSelectState(state) {
    setSelectedBill(null);
    setSelectedState(state);
  }

  const sessionLabel = selectedState?.active_session?.identifier
    ?? selectedState?.session
    ?? '';

  return (
    <div className={styles.panel}>

      {/* ── SIDEBAR ── */}
      <LegislationSidebar
        states={states}
        selectedState={selectedState}
        onSelectState={handleSelectState}
        importStatus={importStatus}
        searchQuery={searchQuery}
        onSearch={setSearchQuery}
      />

      {/* ── MAIN ── */}
      <div className={styles.main}>

        {selectedState ? (
          <>
            {/* Header: state + session + context selector */}
            <div className={styles.mainHeader}>
              <span className={styles.mainHeaderTitle}>
                {selectedState.name}
                {sessionLabel && ` — ${sessionLabel}`}
              </span>
              <select
                className={[
                  styles.contextSelect,
                  context === 'client' && styles.contextClient,
                ].filter(Boolean).join(' ')}
                value={context}
                onChange={e => setContext(e.target.value)}
                aria-label="Research context"
              >
                <option value="personal">Personal Research</option>
                <option value="client">Gleipnir Client</option>
              </select>
            </div>

            {/* Chamber tabs */}
            <div className={styles.chamberTabs} role="tablist">
              {CHAMBERS.map(c => (
                <button
                  key={c.id}
                  role="tab"
                  className={[
                    styles.chamberTab,
                    selectedChamber === c.id && styles.chamberTabActive,
                  ].filter(Boolean).join(' ')}
                  aria-selected={selectedChamber === c.id}
                  onClick={() => {
                    setSelectedChamber(c.id);
                    setSelectedBill(null);
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>

            {/* Status filter chips */}
            <div className={styles.statusFilters} role="group" aria-label="Status filters">
              {STATUSES.map(s => {
                const on = selectedStatuses.includes(s.id);
                return (
                  <button
                    key={s.id}
                    className={[
                      styles.statusChip,
                      STATUS_CHIP_CLASS[s.id],
                      on && styles.statusChipOn,
                    ].filter(Boolean).join(' ')}
                    aria-pressed={on}
                    onClick={() => toggleStatus(s.id)}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>

            {/* Bill list */}
            <BillList
              bills={bills}
              selectedBillId={selectedBill?.id}
              onSelectBill={handleSelectBill}
            />
          </>
        ) : (
          /* No state selected */
          <div className={styles.empty}>
            <div className={styles.emptyIcon} aria-hidden="true">⚖</div>
            <p className={styles.emptyTitle}>Select a state</p>
            <p className={styles.emptySub}>
              {searchQuery.trim().length >= 2
                ? 'Search results will appear across all states'
                : 'Choose a state from the left to browse its active bills'}
            </p>
            {/* Show cross-state search results if a query is active */}
            {searchQuery.trim().length >= 2 && bills.length > 0 && (
              <BillList
                bills={bills}
                selectedBillId={selectedBill?.id}
                onSelectBill={handleSelectBill}
              />
            )}
          </div>
        )}
      </div>

      {/* ── BILL DETAIL SLIDE-IN ── */}
      {selectedBill && (
        <BillDetail
          bill={selectedBill}
          billDetail={billDetail}
          context={context}
          onClose={() => setSelectedBill(null)}
          onRequestCommentary={() =>
            requestCommentary(selectedBill.state_code, selectedBill.id, context)
          }
          onRequestDeepResearch={() =>
            requestDeepResearch(selectedBill.state_code, selectedBill.id, context)
          }
          commentaryLoading={commentaryLoading}
          commentaryTokens={commentaryTokens}
          onOpenAgents={() => onOpenPanel?.('agents')}
        />
      )}

    </div>
  );
}
