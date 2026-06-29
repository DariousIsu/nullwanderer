const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sq', {
  getMeta: (key) => ipcRenderer.invoke('meta:get', key),
  setMeta: (key, value) => ipcRenderer.invoke('meta:set', key, value),
  getRecentHistory: () => ipcRenderer.invoke('history:recent'),
  sendMessage: (text, attachments) => ipcRenderer.invoke('chat:send', text, attachments || []),
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

  onSayToken: (cb) => ipcRenderer.on('chat:say-token', (_e, token) => cb(token)),
  onComplete: (cb) => ipcRenderer.on('chat:complete', (_e, info) => cb(info)),
  onImage: (cb) => ipcRenderer.on('chat:image', (_e, info) => cb(info)),
  onError: (cb) => ipcRenderer.on('chat:error', (_e, err) => cb(err)),
  onBusy: (cb) => ipcRenderer.on('chat:busy', (_e, text) => cb(text)),
  onReflectionFired: (cb) => ipcRenderer.on('reflection:fired', (_e, info) => cb(info)),
  onMonologueTick: (cb) => ipcRenderer.on('monologue:tick', (_e, info) => cb(info)),

  // Open the Editor Studio window directly (kept for back-compat / direct access)
  openEditor: () => ipcRenderer.invoke('editor:open'),
  // Open the My Workspace workbench (Window 3) — hosts the Editor + future surfaces
  openWorkspace: () => ipcRenderer.invoke('workspace:open'),

  // Editor Studio — document registry / lifecycle / checks (all run in main over IPC)
  editor: {
    listDocuments: (opts) => ipcRenderer.invoke('editor:list-documents', opts || {}),
    importDocument: () => ipcRenderer.invoke('editor:import-document'),
    getDocument: (id) => ipcRenderer.invoke('editor:get-document', id),
    getWorkingCopy: (docId, version) => ipcRenderer.invoke('editor:get-working-copy', { docId, version }),
    runChecks: (docId) => ipcRenderer.invoke('editor:run-checks', docId),
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

  // Legislation — read-only bill browser (facets + FTS search + offset-paginated browse + detail).
  leg: {
    facets: (filters) => ipcRenderer.invoke('leg:facets', filters || {}),
    browse: (filters, offset) => ipcRenderer.invoke('leg:browse', { filters: filters || {}, offset: offset || 0 }),
    search: (query, filters) => ipcRenderer.invoke('leg:search', { query, filters: filters || {} }),
    get: (billId) => ipcRenderer.invoke('leg:get', { billId })
  },

  // Knowledge Graph — read-only entity-network explorer (overview + ego-walk + fuzzy search).
  kg: {
    overview: () => ipcRenderer.invoke('kg:overview'),
    ego: (entity, hops) => ipcRenderer.invoke('kg:ego', { entity, hops }),
    search: (query) => ipcRenderer.invoke('kg:search', { query })
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
    ingestNegatives: (text) => ipcRenderer.invoke('puller:ingest-negatives', { text })
  }
});
