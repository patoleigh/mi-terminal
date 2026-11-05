// Puente seguro entre la interfaz y el proceso principal.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args));

contextBridge.exposeInMainWorld('api', {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  saveSession: (s) => ipcRenderer.invoke('sessions:save', s),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  pickKey: () => ipcRenderer.invoke('dialog:pickKey'),

  connect: (opts) => ipcRenderer.invoke('ssh:connect', opts),
  write: (id, data) => ipcRenderer.send('ssh:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('ssh:resize', id, cols, rows),
  disconnect: (id) => ipcRenderer.send('ssh:disconnect', id),
  onData: on('ssh:data'),
  onStatus: on('ssh:status'),
  onClosed: on('ssh:closed'),
  onProgress: on('sftp:progress'),
  onStats: on('ssh:stats'),

  sftp: {
    home: (id) => ipcRenderer.invoke('sftp:home', id),
    list: (id, dir) => ipcRenderer.invoke('sftp:list', id, dir),
    download: (id, p) => ipcRenderer.invoke('sftp:download', id, p),
    upload: (id, dir) => ipcRenderer.invoke('sftp:upload', id, dir),
    // Recibe los archivos soltados en la ventana (no rutas): la interfaz no puede pedir
    // subir un archivo cualquiera del disco, solo los que el usuario arrastró.
    uploadDropped: (id, dir, files) => {
      const paths = Array.from(files || [], (f) => webUtils.getPathForFile(f)).filter(Boolean);
      return ipcRenderer.invoke('sftp:uploadDropped', id, dir, paths);
    },
    mkdir: (id, p) => ipcRenderer.invoke('sftp:mkdir', id, p),
    remove: (id, p, isDir) => ipcRenderer.invoke('sftp:remove', id, p, isDir),
    rename: (id, from, to) => ipcRenderer.invoke('sftp:rename', id, from, to),
    setSudo: (id, on) => ipcRenderer.invoke('sftp:setSudo', id, on),
    edit: (id, p) => ipcRenderer.invoke('sftp:edit', id, p),
  },
  onEdited: on('sftp:edited'),

  editor: {
    get: () => ipcRenderer.invoke('editor:get'),
    choose: () => ipcRenderer.invoke('editor:choose'),
    useSystem: () => ipcRenderer.invoke('editor:useSystem'),
  },

  clipboard: {
    read: () => ipcRenderer.invoke('clipboard:read'),
    write: (text) => ipcRenderer.invoke('clipboard:write', text),
  },
});
