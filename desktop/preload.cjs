'use strict'
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('loomDesktop', Object.freeze({
  state: () => ipcRenderer.invoke('loom-desktop:state'),
  action: action => ipcRenderer.invoke('loom-desktop:action', action),
  notifications: enabled => ipcRenderer.invoke('loom-desktop:notifications', enabled),
  onboarding: (action, input) => ipcRenderer.invoke('loom-desktop:onboarding', action, input),
  onState: callback => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('loom-desktop:changed', listener)
    return () => ipcRenderer.removeListener('loom-desktop:changed', listener)
  },
}))
