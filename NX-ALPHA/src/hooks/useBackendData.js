/**
 * AURA NX-Alpha — Backend Data Hooks
 * Reusable hooks for fetching live data from the FastAPI backend.
 * All hooks return { data, loading, error, refresh }.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

const BASE_URL = 'http://127.0.0.1:8000';

function useFetch(path, { pollMs = 0, deps = [] } = {}) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const timerRef              = useRef(null);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_URL}${path}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [path, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setLoading(true);
    fetch_();
    if (pollMs > 0) {
      timerRef.current = setInterval(fetch_, pollMs);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetch_, pollMs]);

  return { data, loading, error, refresh: fetch_ };
}

// ── Finance ──────────────────────────────────────────────────────────────────

export function useMarketOverview(pollMs = 60000) {
  return useFetch('/data/finance/overview', { pollMs });
}

export function useWatchlist(pollMs = 30000) {
  return useFetch('/data/finance/watchlist', { pollMs });
}

export function useFinanceQuote(ticker, pollMs = 30000) {
  return useFetch(`/data/finance/quote/${ticker}`, { pollMs, deps: [ticker] });
}

// ── Weather ───────────────────────────────────────────────────────────────────

export function useWeather(pollMs = 300000) {
  return useFetch('/data/weather', { pollMs });
}

// ── News ──────────────────────────────────────────────────────────────────────

export function useNews(pollMs = 300000) {
  return useFetch('/data/news', { pollMs });
}

// ── Calendar ──────────────────────────────────────────────────────────────────

export function useCalendar(pollMs = 300000) {
  return useFetch('/data/calendar', { pollMs });
}

// ── Inbox ─────────────────────────────────────────────────────────────────────

export function useInbox(pollMs = 120000) {
  return useFetch('/data/inbox', { pollMs });
}

// ── System Status ─────────────────────────────────────────────────────────────

export function useSystemStatus(pollMs = 30000) {
  return useFetch('/system/status', { pollMs });
}

// ── Google OAuth ──────────────────────────────────────────────────────────────

export function useGoogleStatus() {
  return useFetch('/data/google/status');
}

export async function getGoogleAuthUrl(accountId = null) {
  const params = accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
  const res = await fetch(`${BASE_URL}/data/google/auth-url${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json(); // { url, account_id }
}

export async function activateGoogleAccount(accountId) {
  const res = await fetch(`${BASE_URL}/data/google/accounts/${encodeURIComponent(accountId)}/activate`, { method: 'PUT' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function removeGoogleAccount(accountId) {
  const res = await fetch(`${BASE_URL}/data/google/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Hardware / Queue ──────────────────────────────────────────────────────────

export function useQueueStatus(pollMs = 30000) {
  return useFetch('/queue/status', { pollMs });
}

export function useQueueTasks(pollMs = 30000) {
  return useFetch('/queue/tasks', { pollMs });
}

export async function cancelQueuedTask(taskId) {
  const res = await fetch(`${BASE_URL}/queue/task/${taskId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Knowledge DB ──────────────────────────────────────────────────────────────

export function useKnowledgeSources(pollMs = 30000) {
  return useFetch('/data/knowledge/sources', { pollMs });
}

export async function triggerDownload(sourceId) {
  const res = await fetch(`${BASE_URL}/data/knowledge/download/${sourceId}`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function sweepCollectionFolder() {
  const res = await fetch(`${BASE_URL}/data/knowledge/sweep`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getCollectionFolder() {
  const res = await fetch(`${BASE_URL}/data/knowledge/collection-folder`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function setCollectionFolder(path) {
  const res = await fetch(`${BASE_URL}/data/knowledge/collection-folder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Personal Knowledge Ingestion ──────────────────────────────────────────────

export async function ingestPersonalDoc({ content, type, title, tags = [] }) {
  const res = await fetch(`${BASE_URL}/data/knowledge/personal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, type, title, tags }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function batchIngestPersonal({ path, type, tags = [] }) {
  const res = await fetch(`${BASE_URL}/data/knowledge/personal/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, type, tags }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function updateWatchlist(tickers) {
  const res = await fetch(`${BASE_URL}/data/finance/watchlist`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tickers }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function exchangeGoogleCode(code) {
  const res = await fetch(`${BASE_URL}/data/google/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Conversations ────────────────────────────────────────────────────────────

export function useConversations(pollMs = 30000) {
  return useFetch('/conversations', { pollMs });
}

// ── Storage (§4.5) ────────────────────────────────────────────────────────────

export function useStorage(pollMs = 30000) {
  return useFetch('/storage', { pollMs });
}

export async function setComponentQuota(component, quota_gb) {
  const res = await fetch(`${BASE_URL}/storage/quota`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ component, quota_gb }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Intelligence Service ──────────────────────────────────────────────────────

export function useIntelligenceSources(pollMs = 60000) {
  return useFetch('/data/intelligence/sources', { pollMs });
}

export function useIntelligenceFeed(sourceTypes, limit = 100, hoursBack = 24, pollMs = 300000) {
  const queryParams = new URLSearchParams();
  if (sourceTypes && sourceTypes.length > 0) {
    queryParams.append('types', sourceTypes.join(','));
  }
  queryParams.append('limit', limit.toString());
  queryParams.append('hours_back', hoursBack.toString());
  const path = `/data/intelligence/feed?${queryParams.toString()}`;
  return useFetch(path, { pollMs });
}

export async function updateSourceRank(sourceType, sourceId, rank, enabled) {
  const res = await fetch(`${BASE_URL}/data/intelligence/sources/${sourceType}/${sourceId}/rank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rank, enabled }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function addCustomSource(type, id, config) {
  const res = await fetch(`${BASE_URL}/data/intelligence/sources/custom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, id, config }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── API Key Management ────────────────────────────────────────────────────────

export function useAPIKeys(pollMs = 0) {
  return useFetch('/data/api-keys', { pollMs });
}

export async function updateAPIKeys(keys) {
  const res = await fetch(`${BASE_URL}/data/api-keys`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(keys),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function testAPIKey(service, apiKey) {
  const res = await fetch(`${BASE_URL}/data/api-keys/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service, api_key: apiKey }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Scheduled Tasks ───────────────────────────────────────────────────────────

export function useTasks(pollMs = 120000) {
  return useFetch('/data/tasks', { pollMs });
}

export async function pauseTask(taskId) {
  const res = await fetch(`${BASE_URL}/data/tasks/${taskId}/pause`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function resumeTask(taskId) {
  const res = await fetch(`${BASE_URL}/data/tasks/${taskId}/resume`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function createTask(taskData) {
  const res = await fetch(`${BASE_URL}/data/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(taskData),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail?.error || err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function updateTask(taskId, updates) {
  const res = await fetch(`${BASE_URL}/data/tasks/${taskId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail?.error || err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function deleteTask(taskId) {
  const res = await fetch(`${BASE_URL}/data/tasks/${taskId}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail?.error || err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function runTaskNow(taskId) {
  const res = await fetch(`${BASE_URL}/data/tasks/${taskId}/run-now`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail?.error || err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchTaskHistory(taskId, limit = 50) {
  const res = await fetch(`${BASE_URL}/data/tasks/${taskId}/history?limit=${limit}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Calendar — Multi-Account ──────────────────────────────────────────────────

export function useCalendarAllAccounts(days = 14, pollMs = 300000) {
  return useFetch(`/data/calendar/all-accounts?days=${days}`, { pollMs });
}

export function useCalendarAccounts(pollMs = 60000) {
  return useFetch('/data/calendar/accounts', { pollMs });
}

// ── Voice ────────────────────────────────────────────────────────────────────

export function useVoiceStatus(pollMs = 30000) {
  return useFetch('/voice/status', { pollMs });
}

export function useVoiceDevices() {
  return useFetch('/voice/devices');
}

export async function transcribeAudio(audioBlob) {
  const form = new FormData();
  form.append('audio', audioBlob, 'utterance.webm');
  const res = await fetch(`${BASE_URL}/voice/transcribe`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function synthesizeText(text, speed = 1.0) {
  const res = await fetch(`${BASE_URL}/voice/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, speed }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // Returns raw WAV bytes as an ArrayBuffer
  return res.arrayBuffer();
}

export async function updateVoiceProfile(settings) {
  const res = await fetch(`${BASE_URL}/voice/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function toggleVoice(enabled) {
  const res = await fetch(`${BASE_URL}/voice/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useVoiceModels() {
  return useFetch('/voice/models');
}

export async function downloadVoiceModel(modelId) {
  const res = await fetch(`${BASE_URL}/voice/models/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id: modelId }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Satellites ───────────────────────────────────────────────────────────────

export function useSatellites(pollMs = 60000) {
  return useFetch('/satellites', { pollMs });
}

export function useSatelliteNetworkMap(pollMs = 60000) {
  return useFetch('/satellites/network-map', { pollMs });
}

export function useSatelliteMetrics(id, pollMs = 30000) {
  return useFetch(`/satellites/${id}/metrics`, { pollMs, deps: [id] });
}

export async function scanNetwork(subnet = '') {
  const url = subnet ? `/satellites/scan?subnet=${subnet}` : '/satellites/scan';
  const res = await fetch(`${BASE_URL}${url}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function registerSatellite(data) {
  const res = await fetch(`${BASE_URL}/satellites/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function removeSatellite(id) {
  const res = await fetch(`${BASE_URL}/satellites/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function resetCircuitBreaker(id) {
  const res = await fetch(`${BASE_URL}/satellites/${id}/governor/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function swapModel(id, model) {
  const res = await fetch(`${BASE_URL}/satellites/${id}/model/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function assessHost(host, token = '') {
  const res = await fetch(`${BASE_URL}/satellites/assess`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, token }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function provisionHost(host, steps, token = '') {
  const res = await fetch(`${BASE_URL}/satellites/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, steps, token }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function configureHost(host, config) {
  const res = await fetch(`${BASE_URL}/satellites/configure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, ...config }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getGovernorDefaults() {
  const res = await fetch(`${BASE_URL}/satellites/governor/defaults`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function setGovernorThresholds(id, thresholds) {
  const res = await fetch(`${BASE_URL}/satellites/${id}/governor/thresholds`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(thresholds),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getBootstrapScript() {
  const res = await fetch(`${BASE_URL}/satellites/bootstrap_script`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text(); // Returns raw .ps1 content
}

export function downloadBootstrapScript(scriptContent) {
  const blob = new Blob([scriptContent], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'aura_bootstrap.ps1';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
