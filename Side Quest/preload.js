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
  onMonologueTick: (cb) => ipcRenderer.on('monologue:tick', (_e, info) => cb(info))
});
