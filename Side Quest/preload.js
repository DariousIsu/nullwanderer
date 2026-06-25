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
  }
});
