'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  status: () => ipcRenderer.invoke('desktop:status'),
  setAutostart: enabled => ipcRenderer.invoke('desktop:autostart', enabled),
  setNotifications: enabled => ipcRenderer.invoke('desktop:notifications', enabled),
  notify: (title, body) => ipcRenderer.invoke('desktop:notify', { title, body }),
  openLogs: () => ipcRenderer.invoke('desktop:logs'),
});
