const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('sq', {
  getMeta: (key) => ipcRenderer.invoke('meta:get', key),
  setMeta: (key, value) => ipcRenderer.invoke('meta:set', key, value),
  getRecentHistory: () => ipcRenderer.invoke('history:recent'),
  sendMessage: (text, attachments) => ipcRenderer.invoke('chat:send', text, attachments || []),
  sttTranscribe: (audioBuf) => ipcRenderer.invoke('stt:transcribe', audioBuf),   // two-way voice input: audio bytes → { ok, text }
  onVoiceSpeaking: (cb) => ipcRenderer.on('voice:speaking', (_e, info) => cb(info)),   // conversation mode: {on} — suspend/reopen the ear while she speaks
  speak: (text) => ipcRenderer.invoke('voice:speak', text),   // speak an unprompted utterance aloud (utterances only, never her thoughts)
  onVoicePlay: (cb) => ipcRenderer.on('voice:play', (_e, info) => cb(info)),   // S3: play her voice IN this renderer (AEC reference + instant cancel)
  voicePlayDone: (id, played) => ipcRenderer.send('voice:play-done', id, played),   // ack: clip finished (played=true) or couldn't play (false → OS fallback)
  voiceBarge: () => ipcRenderer.send('voice:barge'),                            // user talked over her → flush the rest of what she was saying
  speakerEnroll: (audioBuf) => ipcRenderer.invoke('speaker:enroll', audioBuf),  // add one enrollment sample of the operator's voice → { ok, count }
  speakerStatus: () => ipcRenderer.invoke('speaker:status'),                     // { enrolled, count, threshold, gate, ... } for the voice-ID gate
  speakerReset: () => ipcRenderer.invoke('speaker:reset'),                       // forget the enrolled voiceprint (re-enroll from scratch)
  getRecentMonologue: (n) => ipcRenderer.invoke('monologue:recent', n),
  getDashboardMetrics: () => ipcRenderer.invoke('dashboard:metrics'),

  // Browser layer
  browserLaunch: () => ipcRenderer.invoke('browser:launch'),
  browserConnect: () => ipcRenderer.invoke('browser:connect'),
  browserDisconnect: () => ipcRenderer.invoke('browser:disconnect'),
  browserStatus: () => ipcRenderer.invoke('browser:status'),
  onBrowserStatus: (cb) => ipcRenderer.on('browser:status', (_e, info) => cb(info)),
  onEchoStatus: (cb) => ipcRenderer.on('echo:status', (_e, info) => cb(info)),
  onInboundArrived: (cb) => ipcRenderer.on('inbound:arrived', (_e, info) => cb(info)),
  onInboundTimeout: (cb) => ipcRenderer.on('inbound:timeout', (_e, info) => cb(info)),

  // Stream-discriminated tokens ({t, s}) forward as (token, stream); legacy bare strings still pass.
  onSayToken: (cb) => ipcRenderer.on('chat:say-token', (_e, p) => { if (p && typeof p === 'object') cb(String(p.t || ''), p.s); else cb(p); }),
  onComplete: (cb) => ipcRenderer.on('chat:complete', (_e, info) => cb(info)),
  onImage: (cb) => ipcRenderer.on('chat:image', (_e, info) => cb(info)),
  onError: (cb) => ipcRenderer.on('chat:error', (_e, err) => cb(err)),
  onBusy: (cb) => ipcRenderer.on('chat:busy', (_e, text) => cb(text)),
  onReflectionFired: (cb) => ipcRenderer.on('reflection:fired', (_e, info) => cb(info)),
  onMonologueTick: (cb) => ipcRenderer.on('monologue:tick', (_e, info) => cb(info)),

  // Open the Editor Studio window directly (kept for back-compat / direct access)
  openEditor: () => ipcRenderer.invoke('editor:open'),
  // Open the My Workspace workbench — the operator surfaces + studios
  openWorkspace: () => ipcRenderer.invoke('workspace:open'),
  // Open Zoe's Canvas — her own window for deliverables + visual aids (distinct from the workbench)
  openCanvas: () => ipcRenderer.invoke('canvas:open'),
  // Usage pill (canvas top bar): Zoe's metered model-token usage over the window + a live /hr rate
  usageSummary: () => ipcRenderer.invoke('usage:summary'),
  // Desktop companion (floating VRM presence): hide her, or toggle her on/off
  companionHide: () => ipcRenderer.invoke('companion:hide'),
  companionToggle: () => ipcRenderer.invoke('companion:toggle'),
  // Companion speech (V4): main hands over a synthesized wav URL to play + lip-sync
  onCompanionSpeak: (cb) => ipcRenderer.on('companion:speak', (_e, info) => cb(info)),
  // Meet-in-canvas (Slice 6): route a Meet URL into Zoe's Canvas pane (she joins as herself). The
  // calendar surface calls joinMeet; the Canvas window listens via onMeetJoin to mount the webview.
  joinMeet: (url, title) => ipcRenderer.invoke('meet:join', { url, title }),
  onMeetJoin: (cb) => ipcRenderer.on('canvas:meet-join', (_e, info) => cb(info)),
  onTeamsJoin: (cb) => ipcRenderer.on('canvas:teams-join', (_e, info) => cb(info)),   // Teams reuses the SINGLE meeting pane, Teams partition
  meetProbe: () => ipcRenderer.invoke('meet:probe'),   // P1 verification: read live Meet-pane state
  // Full-ingestion gate: launch a YouTube video in its own canvas pane with audio ON (for transcription).
  ingestVideo: (url, title) => ipcRenderer.invoke('video:ingest', { url, title }),
  onVideoIngest: (cb) => ipcRenderer.on('canvas:video-ingest', (_e, info) => cb(info)),

  // Monitors widget (canvas news feeds) — subscription CRUD + merged item fetch. Read-only.
  feeds: {
    list: () => ipcRenderer.invoke('feeds:list'),
    add: (url, title) => ipcRenderer.invoke('feeds:add', { url, title }),
    remove: (url) => ipcRenderer.invoke('feeds:remove', { url }),
    fetch: (itemLimit) => ipcRenderer.invoke('feeds:fetch', { itemLimit }),
    videoList: () => ipcRenderer.invoke('feeds:video-list'),
    videoAdd: (url, title) => ipcRenderer.invoke('feeds:video-add', { url, title }),
    videoRemove: (url) => ipcRenderer.invoke('feeds:video-remove', { url }),
    playerBase: () => ipcRenderer.invoke('feeds:player-base'),
    // News lane (Phase B): on-demand brief ("what's going on right now") + the hourly layer push.
    briefing: (sinceMs) => ipcRenderer.invoke('news:briefing', { sinceMs: sinceMs || null }),
    tunerGet: () => ipcRenderer.invoke('news:tuner-get'),
    tunerSet: (tuner) => ipcRenderer.invoke('news:tuner-set', { tuner }),
    onLayer: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('news:layer', h); return () => ipcRenderer.removeListener('news:layer', h); }
  },

  // API management stream — raw-pull hooks for other sections (forecasting) + management views.
  api: {
    datasets: () => ipcRenderer.invoke('api:datasets'),
    snapshot: (datasetId) => ipcRenderer.invoke('api:snapshot', { datasetId }),           // persisted snapshot, no network
    pull: (apiId, path, params) => ipcRenderer.invoke('api:pull', { apiId, path, params }), // on-demand live pull (rate-limited/cached)
    refresh: (datasetId, force) => ipcRenderer.invoke('api:refresh', { datasetId, force }),
    keyStatus: () => ipcRenderer.invoke('api:key-status'),
    health: () => ipcRenderer.invoke('api:health')
  },

  // Editor Studio — document registry / lifecycle / checks (all run in main over IPC)
  editor: {
    listDocuments: (opts) => ipcRenderer.invoke('editor:list-documents', opts || {}),
    importDocument: () => ipcRenderer.invoke('editor:import-document'),
    getDocument: (id) => ipcRenderer.invoke('editor:get-document', id),
    getWorkingCopy: (docId, version) => ipcRenderer.invoke('editor:get-working-copy', { docId, version }),
    importPath: (filePath) => ipcRenderer.invoke('editor:import-path', filePath),      // drag-drop import
    pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },  // File → OS path (Electron 42: File.path removed)
    listCitations: (docId) => ipcRenderer.invoke('editor:list-citations', docId),      // citations found in the doc (pre-run)
    attachSource: (docId, uid, filePath) => ipcRenderer.invoke('editor:attach-source', { docId, uid, filePath }),  // tag in-hand source to a citation
    detachSource: (docId, uid) => ipcRenderer.invoke('editor:detach-source', { docId, uid }),
    runChecks: (docId) => ipcRenderer.invoke('editor:run-checks', docId),
    exportReport: (docId, mapped) => ipcRenderer.invoke('editor:export-report', { docId, mapped }),  // findings report for the author (not a cert)
    exportDoc: (docId, format) => ipcRenderer.invoke('editor:export-doc', { docId, format }),        // the reviewed DOCUMENT itself (pdf|docx|md)
    ocrPages: (docId, pages) => ipcRenderer.invoke('editor:ocr-pages', { docId, pages }),            // read image-only PDF pages via vision
    certify: (docId, mapped) => ipcRenderer.invoke('editor:certify', { docId, mapped }),
    publish: (docId, publicCopyRef) => ipcRenderer.invoke('editor:publish', { docId, publicCopyRef })
  },

  // Super Search — the unified search studio. The whole deterministic pathway (plan → retrieve
  // both lanes → rerank → cited overview → gated ingest) runs in main over one IPC call.
  search: {
    run: (query, opts) => ipcRenderer.invoke('search:run', { query, opts: opts || {} }),
    revert: (id) => ipcRenderer.invoke('search:revert', { id }),
    status: () => ipcRenderer.invoke('search:status')
  },

  // Forecasting — downstream processing surface. Each model's widget payload is built in main
  // (lib/forecast_service) from the poll connectors; read-only, no prod DB.
  forecast: {
    widgets: () => ipcRenderer.invoke('forecast:widgets'),
    pollAverage: (opts) => ipcRenderer.invoke('forecast:poll-average', opts || {}),
    balance: (opts) => ipcRenderer.invoke('forecast:balance', opts || {}),
    calibration: () => ipcRenderer.invoke('forecast:calibration'),
    scenarioList: () => ipcRenderer.invoke('forecast:scenario-list'),
    scenario: (opts) => ipcRenderer.invoke('forecast:scenario', opts || {})
  },

  // Polling — read-only data browser over the engine's polling tools (main maps to view shapes).
  poll: {
    list: (opts) => ipcRenderer.invoke('poll:list', opts || {}),
    get: (fieldingId) => ipcRenderer.invoke('poll:get', { fieldingId }),
    question: (questionId) => ipcRenderer.invoke('poll:question', { questionId }),
    issues: () => ipcRenderer.invoke('poll:issues')
  },

  // CRM (Rolodex) — read-only contact browser (facets + search + paginated browse + detail).
  crm: {
    facets: (filters) => ipcRenderer.invoke('crm:facets', filters || {}),
    browse: (filters) => ipcRenderer.invoke('crm:browse', filters || {}),
    search: (query, filters) => ipcRenderer.invoke('crm:search', { query, filters: filters || {} }),
    page: (cursor) => ipcRenderer.invoke('crm:page', { cursor }),
    get: (contactId) => ipcRenderer.invoke('crm:get', { contactId })
  },

  // Calendar — near-1:1 Google Calendar (operator's account, via Echo's OAuth). Read-only in Slice 1.
  calendar: {
    authStatus: () => ipcRenderer.invoke('calendar:auth-status'),
    connect: () => ipcRenderer.invoke('calendar:connect'),
    listCalendars: () => ipcRenderer.invoke('calendar:list-calendars'),
    events: (calendars, timeMin, timeMax) => ipcRenderer.invoke('calendar:events', { calendars, timeMin, timeMax }),
    createEvent: (calendarId, form) => ipcRenderer.invoke('calendar:create-event', { calendarId, form }),
    updateEvent: (calendarId, eventId, form) => ipcRenderer.invoke('calendar:update-event', { calendarId, eventId, form }),
    deleteEvent: (calendarId, eventId) => ipcRenderer.invoke('calendar:delete-event', { calendarId, eventId })
  },

  // Legislation — read-only bill browser (facets + FTS search + offset-paginated browse + detail).
  leg: {
    facets: (filters) => ipcRenderer.invoke('leg:facets', filters || {}),
    browse: (filters, offset) => ipcRenderer.invoke('leg:browse', { filters: filters || {}, offset: offset || 0 }),
    search: (query, filters) => ipcRenderer.invoke('leg:search', { query, filters: filters || {} }),
    get: (billId) => ipcRenderer.invoke('leg:get', { billId })
  },

  // People rail — contact cards discovered from dropped docs (recency waterfall + live push).
  contacts: {
    recent: (n) => ipcRenderer.invoke('contacts:recent', { n }),
    openBriefing: (targetId) => ipcRenderer.invoke('contacts:open-briefing', { targetId }),
    openCrm: (crmId) => ipcRenderer.invoke('contacts:open-crm', { crmId }),
    onCard: (cb) => { const h = (_e, c) => { try { cb(c); } catch (e) {} }; ipcRenderer.on('contacts:card', h); return () => ipcRenderer.removeListener('contacts:card', h); },
  },

  // Workspace shell — main asks it to activate a surface (e.g. Puller, deep-linked to a target).
  workspace: {
    onOpenSurface: (cb) => { const h = (_e, d) => { try { cb(d); } catch (e) {} }; ipcRenderer.on('workspace:open-surface', h); return () => ipcRenderer.removeListener('workspace:open-surface', h); },
  },

  // Knowledge Graph — read-only entity-network explorer (overview + ego-walk + fuzzy search).
  kg: {
    overview: () => ipcRenderer.invoke('kg:overview'),
    ego: (entity, hops) => ipcRenderer.invoke('kg:ego', { entity, hops }),
    search: (query) => ipcRenderer.invoke('kg:search', { query }),
    shortterm: () => ipcRenderer.invoke('kg:shortterm'),   // two-source: Side Quest short-term layer (local graph + recent docs)
    self: () => ipcRenderer.invoke('kg:self'),             // Zoe's own self-model — the personality that LIVES in the short-term region
    // live-follow: main broadcasts kg:focus-move on each idle graph-walk move → the panel can re-center.
    onFocusMove: (cb) => { const h = (_e, p) => { try { cb(p); } catch (e) {} }; ipcRenderer.on('kg:focus-move', h); return () => ipcRenderer.removeListener('kg:focus-move', h); },
    // curation metabolism: main broadcasts kg:curation-move when the self-curation engine lands a batch
    // ({tier:'growth'|'curation'|'clean', kind, count, items?, anchor?}). Inert until the host emits it.
    onCurationMove: (cb) => { const h = (_e, p) => { try { cb(p); } catch (e) {} }; ipcRenderer.on('kg:curation-move', h); return () => ipcRenderer.removeListener('kg:curation-move', h); },
    // kg:activity — the generalized data-activity bus (Stage A). main broadcasts kg:activity
    // {db,kind,anchor,anchor2,count,tier,epistemic,meta} from real DB writes on both stores; the renderer's
    // onActivity dispatcher routes on `kind`. Inert until the host emits it. (kg:curation-move stays as its
    // own live dedup path — this bus carries the born/enrich/edge/match/recall/promote/doc/news/think feeds.)
    onActivity: (cb) => { const h = (_e, p) => { try { cb(p); } catch (e) {} }; ipcRenderer.on('kg:activity', h); return () => ipcRenderer.removeListener('kg:activity', h); },
    // dev-only: fire a real main→preload→renderer kg:activity round-trip (proves Slice 1 transport over CDP).
    devActivity: (payload) => ipcRenderer.invoke('kg:dev-activity', payload)
  },

  // Observability bus — the self-development feed (docs/OBS_INTERFACE_HOOKS.md): the autonomous system
  // observing itself. Read-only from here: catch-up poll on the id cursor + the live obs:event push
  // (push events carry NO id — display only; ids are authoritative on the poll path).
  obs: {
    recent: (opts) => ipcRenderer.invoke('obs:recent', opts || {}),
    onEvent: (cb) => { const h = (_e, evt) => { try { cb(evt); } catch (e) {} }; ipcRenderer.on('obs:event', h); return () => ipcRenderer.removeListener('obs:event', h); },
  },

  // Reader / Library — read-only corpus reader on the document substrate.
  reader: {
    projects: () => ipcRenderer.invoke('reader:projects'),
    list: (project) => ipcRenderer.invoke('reader:list', { project }),
    get: (docId) => ipcRenderer.invoke('reader:get', { docId }),
    bytes: (docId) => ipcRenderer.invoke('reader:bytes', { docId })
  },

  // Creator — authoring surface on the document substrate (Tiptap host; block⇄PM bridge in main).
  creator: {
    list: (opts) => ipcRenderer.invoke('creator:list', opts || {}),
    get: (docId) => ipcRenderer.invoke('creator:get', { docId }),
    newDoc: (title) => ipcRenderer.invoke('creator:new', { title }),
    save: (docId, docJson) => ipcRenderer.invoke('creator:save', { docId, docJson }),
    scan: (docJson) => ipcRenderer.invoke('creator:scan', { docJson }),
    proofread: (docJson, onlyAnchors) => ipcRenderer.invoke('creator:proofread', { docJson, onlyAnchors }),
    research: (docJson, web) => ipcRenderer.invoke('creator:research', { docJson, web }),
    advise: (docJson, context) => ipcRenderer.invoke('creator:advise', { docJson, context }),
    openSource: (docId) => ipcRenderer.invoke('creator:open-source', { docId }),
    openExternal: (url) => ipcRenderer.invoke('creator:open-external', { url })
  },

  // Puller — person/org research workbench (dossier surface + single-dossier write actions).
  puller: {
    listTargets: (opts) => ipcRenderer.invoke('puller:list-targets', opts || {}),
    getDossier: (targetId) => ipcRenderer.invoke('puller:get-dossier', { targetId }),
    markVerification: (targetId, result, value) => ipcRenderer.invoke('puller:mark-verification', { targetId, result, value }),
    decideRevision: (targetId, revisionId, decision) => ipcRenderer.invoke('puller:decide-revision', { targetId, revisionId, decision }),
    markDedicated: (targetId, value, note) => ipcRenderer.invoke('puller:mark-dedicated', { targetId, value, note }),
    promote: (targetId, crmId) => ipcRenderer.invoke('puller:promote', { targetId, crmId }),
    exportContacts: (opts) => ipcRenderer.invoke('puller:export', opts || {}),
    seedPriors: () => ipcRenderer.invoke('puller:seed-priors'),
    cascade: (domain) => ipcRenderer.invoke('puller:cascade', { domain }),
    ingestNegatives: (text) => ipcRenderer.invoke('puller:ingest-negatives', { text }),
    // F4 drop-zone: a bounce report of ANY format (DSN/ARF/ESP JSON/CSV/free text), auto-sniffed.
    ingestBounces: (text, opts) => ipcRenderer.invoke('puller:ingest-bounces', { text, ...(opts || {}) }),
    reconcileTestList: (sent, resultsText) => ipcRenderer.invoke('puller:reconcile-testlist', { sent, resultsText }),
    // F4 correction loop: contextual identity-dedup sweep + operator merge/reassign/split.
    dedupSweep: (apply) => ipcRenderer.invoke('puller:dedup-sweep', { apply: !!apply }),
    applyMerge: (fromId, intoId, reason) => ipcRenderer.invoke('puller:apply-merge', { fromId, intoId, reason }),
    unmerge: (correctionId) => ipcRenderer.invoke('puller:unmerge', { correctionId }),
    reassignObservation: (obsId, toTargetId, reason) => ipcRenderer.invoke('puller:reassign-observation', { obsId, toTargetId, reason }),
    splitTarget: (fromId, obsIds, name, opts) => ipcRenderer.invoke('puller:split-target', { fromId, obsIds, name, ...(opts || {}) }),
    listCorrections: (opts) => ipcRenderer.invoke('puller:list-corrections', opts || {})
  },

  // Canvas — Zoe's freeform whiteboard over Echo's saga canvas (live /canvas snapshot). Content is
  // read-only (Echo owns blocks); the spatial LAYOUT (block positions) is Side-Quest-owned + persisted.
  canvas: {
    getAll: () => ipcRenderer.invoke('canvas:get-all'),
    listTabs: (opts) => ipcRenderer.invoke('canvas:list-tabs', opts || {}),
    getTab: (tabKey) => ipcRenderer.invoke('canvas:get-tab', { tabKey }),
    setDocPos: (tabKey, x, y) => ipcRenderer.invoke('canvas:set-doc-pos', { tabKey, x, y }),
    updateDoc: (tabKey, patch) => ipcRenderer.invoke('canvas:update-doc', { tabKey, patch }),
    resetLayout: (tabKey) => ipcRenderer.invoke('canvas:reset-layout', { tabKey }),
    dropDoc: (filePath, x, y) => ipcRenderer.invoke('canvas:drop-doc', { path: filePath, x, y }),
    exportDoc: (payload) => ipcRenderer.invoke('canvas:export-doc', payload)   // { title, html, format:'pdf'|'docx' }
  },
  // Resolve a dropped File's real OS path (Electron removed File.path; webUtils is the supported way).
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } }
});
