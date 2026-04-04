/**
 * AURA NX-Alpha — useLegislation
 *
 * Data layer for the Legislation drop panel.
 *
 * RESPONSIBILITIES:
 *   - Fetch all states with imported data on mount
 *   - Poll import status until running = false (every 3s)
 *   - Fetch bills when state or chamber changes (no status filter — filtered client-side)
 *   - Fetch full bill detail when selectedBill changes
 *   - Handle full-text search via GET /legislation/search
 *   - Stream AI commentary via POST + ReadableStream (not EventSource — backend is POST)
 *
 * COMMENTARY STREAMING:
 *   Uses fetch() + resp.body.getReader() to consume a text/event-stream response.
 *   Lines are buffered across chunks and parsed as SSE data events.
 *   AbortController cancels any in-flight stream when a new request starts.
 *
 * STATUS FILTERING:
 *   The backend accepts only a single `status` query param. Since the UI allows
 *   multi-status toggle chips, bills are fetched unfiltered and sliced client-side.
 *   Search results are returned as-is (no additional status filter applied).
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

const API = 'http://localhost:8000';

/**
 * @param {object|null}   selectedState  — selected state object from states list
 * @param {string}        chamber        — 'house' | 'senate' | 'reconciled'
 * @param {string[]}      statuses       — active filter chip values
 * @param {object|null}   selectedBill   — shallow bill from list (triggers detail fetch)
 */
export function useLegislation(selectedState, chamber, statuses, selectedBill) {
  const [states,           setStates]           = useState([]);
  const [importStatus,     setImportStatus]     = useState(null);
  const [rawBills,         setRawBills]         = useState([]);
  const [searchResults,    setSearchResults]    = useState(null); // null = not in search mode
  const [billDetail,       setBillDetail]       = useState(null);
  const [searchQuery,      setSearchQuery]      = useState('');
  const [commentaryTokens, setCommentaryTokens] = useState('');
  const [commentaryLoading, setCommentaryLoading] = useState(false);

  const importPollRef      = useRef(null);
  const commentaryAbortRef = useRef(null);

  // ── IMPORT STATUS POLLING ────────────────────────────────────────────────────
  // Polls every 3s while import is running, stops when complete.

  const pollImportStatus = useCallback(() => {
    fetch(`${API}/legislation/import/status`)
      .then(r => r.json())
      .then(status => {
        setImportStatus(status);
        if (status.running || status.progress?.running) {
          importPollRef.current = setTimeout(pollImportStatus, 3000);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    // Fetch states list
    fetch(`${API}/legislation/states`)
      .then(r => r.json())
      .then(d => setStates(d.states || []));

    // Start import status polling
    pollImportStatus();

    return () => {
      clearTimeout(importPollRef.current);
      commentaryAbortRef.current?.abort();
    };
  }, [pollImportStatus]);

  // ── BILLS — fetch when state / chamber changes ────────────────────────────────
  // No status param — filter client-side to support multi-status chip toggles.

  useEffect(() => {
    if (!selectedState) { setRawBills([]); return; }
    const params = new URLSearchParams();
    if (chamber) params.set('chamber', chamber);
    params.set('limit', '500');
    fetch(`${API}/legislation/states/${selectedState.code}/bills?${params}`)
      .then(r => r.json())
      .then(d => setRawBills(d.bills || []))
      .catch(() => setRawBills([]));
  }, [selectedState?.code, chamber]);

  // ── SEARCH — fires when searchQuery changes (debounced via min length) ────────

  useEffect(() => {
    if (searchQuery.trim().length < 2) {
      setSearchResults(null);
      return;
    }
    const params = new URLSearchParams({ q: searchQuery });
    if (selectedState) params.set('state', selectedState.code);
    fetch(`${API}/legislation/search?${params}`)
      .then(r => r.json())
      .then(d => setSearchResults(d.results || []))
      .catch(() => setSearchResults([]));
  }, [searchQuery, selectedState?.code]);

  // ── BILL DETAIL — fetch when selected bill changes ────────────────────────────

  useEffect(() => {
    if (!selectedBill || !selectedState) { setBillDetail(null); return; }
    // Clear stale detail immediately so BillDetail shows loading state
    setBillDetail(null);
    fetch(`${API}/legislation/states/${selectedState.code}/bills/${selectedBill.id}`)
      .then(r => r.json())
      .then(setBillDetail)
      .catch(() => setBillDetail(null));
    // Also clear any previous commentary stream
    setCommentaryTokens('');
    setCommentaryLoading(false);
  }, [selectedBill?.id, selectedState?.code]);

  // ── DERIVED BILL LIST ─────────────────────────────────────────────────────────
  // When searching: return search results (status chip filters not applied).
  // When browsing a state: return rawBills filtered by active status chips.

  const bills = useMemo(() => {
    if (searchQuery.trim().length >= 2) return searchResults ?? [];
    return rawBills.filter(b => statuses.includes(b.status));
  }, [searchQuery, searchResults, rawBills, statuses]);

  // ── DEEP RESEARCH — fires message into main chat pipeline ────────────────────

  const requestDeepResearch = useCallback(async (stateCode, billId, context) => {
    try {
      await fetch(
        `${API}/legislation/states/${stateCode}/bills/${billId}/deep-research?context=${context}`,
        { method: 'POST' },
      );
    } catch (err) {
      console.error('[useLegislation] deep research request error:', err);
    }
  }, []);

  // ── AI COMMENTARY — POST + ReadableStream ─────────────────────────────────────

  const requestCommentary = useCallback(async (stateCode, billId, context) => {
    // Cancel any in-flight stream
    commentaryAbortRef.current?.abort();
    const controller = new AbortController();
    commentaryAbortRef.current = controller;

    setCommentaryTokens('');
    setCommentaryLoading(true);

    try {
      const resp = await fetch(
        `${API}/legislation/states/${stateCode}/bills/${billId}/commentary?context=${context}`,
        { method: 'POST', signal: controller.signal },
      );

      if (!resp.ok || !resp.body) {
        setCommentaryLoading(false);
        return;
      }

      const reader  = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer    = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          try {
            const data = JSON.parse(raw);
            if (data.token) setCommentaryTokens(prev => prev + data.token);
            if (data.error) setCommentaryTokens(prev => prev + `[Error: ${data.error}]`);
            if (data.done)  { setCommentaryLoading(false); return; }
          } catch { /* malformed line — skip */ }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[useLegislation] commentary stream error:', err);
      }
    }

    setCommentaryLoading(false);
  }, []);

  return {
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
  };
}
