// Proceso principal: ventana, sesiones guardadas, conexiones SSH, SFTP y túneles.
const { app, BrowserWindow, ipcMain, dialog, safeStorage, clipboard, shell } = require('electron');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { Client } = require('ssh2');
const { convertPpk, isPpk, PpkError } = require('./ppk');
const { startStats } = require('./stats');
const { listShells, openShell } = require('./local');

let win;

// En la versión instalada no se permite abrir la app con depuración remota:
// cualquiera que la lance así podría controlar la ventana.
if (app.isPackaged && app.commandLine.hasSwitch('remote-debugging-port')) {
  app.exit(1);
}

// Misma carpeta de datos en desarrollo y en la versión instalada (%APPDATA%\mi-terminal).
// Se respeta --user-data-dir para poder probar con datos aparte.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'mi-terminal'));
}

// Una sola instancia: dos ventanas guardando sesiones a la vez podrían pisarse.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// Solo la ventana de la app (cargada desde sus propios archivos) puede usar las funciones internas.
const APP_PAGE = path.resolve(__dirname, 'renderer', 'index.html').toLowerCase();
function isAppPage(url) {
  try {
    return require('url').fileURLToPath(url).toLowerCase() === APP_PAGE;
  } catch {
    return false;
  }
}
function checkSender(e) {
  if (!win || e.sender !== win.webContents || !isAppPage(e.senderFrame?.url)) {
    throw new Error('Llamada no permitida');
  }
}
const handle = (channel, fn) =>
  ipcMain.handle(channel, (e, ...args) => {
    checkSender(e);
    return fn(e, ...args);
  });
const on = (channel, fn) =>
  ipcMain.on(channel, (e, ...args) => {
    try {
      checkSender(e);
    } catch {
      return;
    }
    fn(e, ...args);
  });
const conns = new Map(); // connId -> { client, stream, sftp, servers, remoteTunnels }

// ---------- Almacenamiento ----------

const dataDir = () => app.getPath('userData');
const sessionsFile = () => path.join(dataDir(), 'sessions.json');
const knownHostsFile = () => path.join(dataDir(), 'known_hosts.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Se escribe en un archivo aparte y luego se reemplaza: si el PC se apaga a mitad, no se pierden las sesiones.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// Las contraseñas se cifran con el almacén del sistema (DPAPI en Windows).
function encrypt(text) {
  if (!text) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('El cifrado del sistema no está disponible; no se puede guardar la contraseña.');
  }
  return safeStorage.encryptString(text).toString('base64');
}

function decrypt(b64) {
  return b64 ? safeStorage.decryptString(Buffer.from(b64, 'base64')) : '';
}

const loadSessions = () => readJson(sessionsFile(), []);

// La interfaz nunca recibe secretos, solo si existen.
function publicSession(s) {
  const { password, passphrase, ...rest } = s;
  return { ...rest, hasPassword: !!password, hasPassphrase: !!passphrase };
}

handle('sessions:list', () => loadSessions().map(publicSession));

handle('sessions:save', (_e, input) => {
  const list = loadSessions();
  const idx = list.findIndex((s) => s.id === input.id);
  const prev = idx >= 0 ? list[idx] : {};
  const s = {
    id: input.id || crypto.randomUUID(),
    name: input.name || input.host,
    folder: input.folder || '',
    host: input.host,
    port: Number(input.port) || 22,
    username: input.username,
    authType: input.authType || 'password',
    keyPath: input.keyPath || '',
    tunnels: Array.isArray(input.tunnels) ? input.tunnels : [],
    sftpSudo: input.sftpSudo ?? prev.sftpSudo ?? false,
    // undefined = conservar, '' = borrar, texto = reemplazar
    password: input.password === undefined ? prev.password || null : encrypt(input.password),
    passphrase: input.passphrase === undefined ? prev.passphrase || null : encrypt(input.passphrase),
  };
  // No guardar secretos que el tipo de autenticación elegido no usa.
  if (s.authType !== 'password') s.password = null;
  if (s.authType !== 'key') s.passphrase = null;
  if (idx >= 0) list[idx] = s;
  else list.push(s);
  writeJson(sessionsFile(), list);
  return publicSession(s);
});

handle('sessions:delete', (_e, id) => {
  writeJson(sessionsFile(), loadSessions().filter((s) => s.id !== id));
});

handle('dialog:pickKey', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Elegir clave privada',
    defaultPath: path.join(app.getPath('home'), '.ssh'),
    properties: ['openFile', 'showHiddenFiles'],
  });
  return r.canceled ? null : r.filePaths[0];
});

handle('clipboard:read', () => clipboard.readText());
handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));

// ---------- Verificación del servidor (como known_hosts) ----------

function verifyHost(host, port, key, verify) {
  const id = `[${host}]:${port}`;
  const fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  const known = readJson(knownHostsFile(), {});

  if (known[id] === fp) return verify(true);

  if (known[id]) {
    dialog
      .showMessageBox(win, {
        type: 'error',
        title: 'La clave del servidor cambió',
        message: `La huella de ${id} no coincide con la guardada.`,
        detail:
          `Guardada: ${known[id]}\nRecibida: ${fp}\n\n` +
          'Puede ser una reinstalación del servidor o un intento de suplantación. Conexión cancelada.\n' +
          `Si el cambio es legítimo, borra esa entrada de:\n${knownHostsFile()}`,
      })
      .then(() => verify(false));
    return;
  }

  dialog
    .showMessageBox(win, {
      type: 'question',
      buttons: ['Confiar y conectar', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'Servidor desconocido',
      message: `Primera conexión a ${id}`,
      detail: `Huella: ${fp}\n\n¿Confías en este servidor?`,
    })
    .then(({ response }) => {
      if (response === 0) {
        known[id] = fp;
        writeJson(knownHostsFile(), known);
        verify(true);
      } else {
        verify(false);
      }
    });
}

// ---------- SSH ----------

const send = (channel, ...args) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
};

function cleanup(connId) {
  const c = conns.get(connId);
  if (!c) return;
  c.servers.forEach((s) => s.close());
  stopEdits(connId, c);
  conns.delete(connId);
}

function startTunnels(connId, conn, tunnels = []) {
  for (const t of tunnels) {
    const src = Number(t.srcPort);
    const dstPort = Number(t.dstPort);
    const label = `${t.type === 'R' ? 'remoto' : 'local'} ${src} → ${t.dstHost}:${dstPort}`;

    if (t.type === 'R') {
      // El servidor escucha en su puerto src y lo reenvía a dstHost:dstPort desde este equipo.
      conn.client.forwardIn('127.0.0.1', src, (err) => {
        if (err) return send('ssh:status', connId, `Túnel ${label} falló: ${err.message}`);
        conn.remoteTunnels.set(src, { dstHost: t.dstHost, dstPort });
        send('ssh:status', connId, `Túnel ${label} activo`);
      });
    } else {
      // Este equipo escucha en 127.0.0.1:src y lo reenvía a dstHost:dstPort desde el servidor.
      const server = net.createServer((sock) => {
        conn.client.forwardOut('127.0.0.1', sock.remotePort || 0, t.dstHost, dstPort, (err, ch) => {
          if (err) return sock.destroy();
          sock.pipe(ch).pipe(sock);
          ch.on('error', () => sock.destroy());
          sock.on('error', () => ch.close());
        });
      });
      server.on('error', (err) => send('ssh:status', connId, `Túnel ${label} falló: ${err.message}`));
      server.listen(src, '127.0.0.1', () => send('ssh:status', connId, `Túnel ${label} activo`));
      conn.servers.push(server);
    }
  }
}

handle('ssh:connect', async (_e, { connId, sessionId, password, cols, rows }) => {
  const s = loadSessions().find((x) => x.id === sessionId);
  if (!s) throw new Error('Sesión no encontrada');
  // La clave se prepara antes (convertir un .ppk puede tardar un momento).
  const keyInfo = s.authType === 'key' ? await loadPrivateKey(s.keyPath, password ?? decrypt(s.passphrase)) : null;

  return new Promise((resolve, reject) => {
    const cfg = {
      host: s.host,
      port: s.port,
      username: s.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      tryKeyboard: true,
      hostVerifier: (key, verify) => verifyHost(s.host, s.port, key, verify),
      // Sin algoritmos con SHA-1 (obsoletos). Ubuntu 16.04 en adelante no los necesita.
      algorithms: {
        serverHostKey: { remove: ['ssh-rsa'] },
        hmac: { remove: ['hmac-sha1', 'hmac-sha1-etm@openssh.com'] },
      },
    };

    let secret = '';
    try {
      if (keyInfo) {
        cfg.privateKey = keyInfo.key;
        if (keyInfo.passphrase) cfg.passphrase = keyInfo.passphrase;
      } else if (s.authType === 'agent') {
        cfg.agent = process.env.SSH_AUTH_SOCK || '\\\\.\\pipe\\openssh-ssh-agent';
      } else {
        secret = password ?? decrypt(s.password);
        cfg.password = secret;
      }
    } catch (err) {
      return reject(err);
    }

    const client = new Client();
    const conn = {
      client,
      stream: null,
      sftp: null,
      sftpPromise: null,
      sudo: !!s.sftpSudo,
      sessionId: s.id,
      edits: new Map(),
      servers: [],
      remoteTunnels: new Map(),
    };
    conns.set(connId, conn);
    const isCurrent = () => conns.get(connId)?.client === client;
    let settled = false;

    // La contraseña solo se entrega si el servidor pide exactamente una contraseña
    // (no a otras preguntas, como un código de verificación).
    client.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
      const asksPassword = prompts.length === 1 && !prompts[0].echo && /password|contrase/i.test(prompts[0].prompt);
      finish(secret && asksPassword ? [secret] : prompts.map(() => ''));
    });

    client.on('ready', () => {
      // Sin esto, TCP agrupa las teclas y espera confirmaciones: se nota como lag al escribir.
      client.setNoDelay(true);
      client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) {
          settled = true;
          client.end();
          return reject(err);
        }
        conn.stream = stream;
        stream.on('data', (d) => send('ssh:data', connId, d));
        stream.stderr.on('data', (d) => send('ssh:data', connId, d));
        stream.on('close', () => client.end());
        startTunnels(connId, conn, s.tunnels);
        startStats(client, (st) => send('ssh:stats', connId, st));
        settled = true;
        resolve({ ok: true });
      });
    });

    client.on('tcp connection', (info, accept, rejectConn) => {
      const t = conn.remoteTunnels.get(info.destPort);
      if (!t) return rejectConn();
      const ch = accept();
      const sock = net.connect(t.dstPort, t.dstHost);
      ch.pipe(sock).pipe(ch);
      sock.on('error', () => ch.close());
      ch.on('error', () => sock.destroy());
    });

    client.on('error', (err) => {
      if (!settled) {
        settled = true;
        if (isCurrent()) cleanup(connId);
        reject(new Error(explainError(err.message, s)));
      } else {
        send('ssh:status', connId, `Error: ${err.message}`);
      }
    });

    client.on('close', () => {
      if (!isCurrent()) return; // intento anterior ya descartado
      cleanup(connId);
      send('ssh:closed', connId);
    });

    try {
      client.connect(cfg);
    } catch (err) {
      cleanup(connId);
      reject(new Error(explainError(err.message, s)));
    }
  });
});

// Lee la clave privada. Las claves PuTTY (.ppk) se convierten a OpenSSH en memoria.
async function loadPrivateKey(keyPath, passphrase) {
  if (!keyPath) throw new Error('La sesión no tiene archivo de clave. Edítala y elige uno.');
  let text;
  try {
    text = fs.readFileSync(keyPath, 'utf8');
  } catch {
    throw new Error(`No se pudo leer el archivo de clave: ${keyPath}`);
  }
  if (/^ssh-\w+ AAAA|^ecdsa-sha2-\S+ AAAA/.test(text.trim())) {
    throw new Error('Elegiste la clave pública (.pub). Elige el archivo de la clave privada.');
  }
  if (!isPpk(text)) return { key: text, passphrase };
  try {
    return { key: await convertPpk(text, passphrase) };
  } catch (err) {
    if (err instanceof PpkError) {
      // "passphrase" hace que la interfaz pida la frase de paso y reintente.
      throw new Error(`${err.message} (passphrase)`);
    }
    throw err;
  }
}

// Traduce los errores más comunes de ssh2 a algo accionable.
function explainError(msg, s) {
  if (/no passphrase given|bad passphrase|decrypt/i.test(msg)) {
    return 'La clave está protegida: falta la frase de paso o es incorrecta (passphrase)';
  }
  if (/All configured authentication methods failed/i.test(msg)) {
    return s.authType === 'password'
      ? 'El servidor rechazó la contraseña. Si es un servidor AWS EC2, normalmente solo acepta clave privada: edita la sesión y elige "Clave privada". (authentication methods failed)'
      : 'El servidor rechazó la clave. Revisa que sea la clave correcta para este servidor y usuario. (authentication methods failed)';
  }
  if (/Unsupported key format|Cannot parse privateKey/i.test(msg)) {
    return 'No se reconoce el formato de la clave. Usa una clave OpenSSH (id_rsa, id_ed25519) o PuTTY (.ppk).';
  }
  if (/ECONNREFUSED/.test(msg)) return `${s.host}:${s.port} rechazó la conexión. ¿El puerto es correcto y el servicio SSH está activo?`;
  if (/ETIMEDOUT|Timed out/i.test(msg)) return `No hubo respuesta de ${s.host}:${s.port}. Revisa la IP, tu red o el firewall / Security Group.`;
  if (/ENOTFOUND/.test(msg)) return `No se encontró el host "${s.host}".`;
  return msg;
}

on('ssh:write', (_e, connId, data) => {
  const local = locals.get(connId);
  if (local) return local.write(String(data));
  conns.get(connId)?.stream?.write(data);
});

on('ssh:resize', (_e, connId, cols, rows) => {
  const local = locals.get(connId);
  if (local) {
    try {
      local.resize(cols, rows);
    } catch {
      /* la consola ya terminó */
    }
    return;
  }
  conns.get(connId)?.stream?.setWindow(rows, cols, 0, 0);
});

on('ssh:disconnect', (_e, connId) => {
  if (locals.has(connId)) return closeLocal(connId);
  conns.get(connId)?.client.end();
});

// ---------- Consolas locales (CMD, PowerShell, WSL…) ----------
// Usan los mismos canales que una conexión SSH: para la interfaz son una pestaña más.

const locals = new Map(); // connId -> pseudo-terminal

function closeLocal(connId) {
  const p = locals.get(connId);
  if (!p) return;
  locals.delete(connId);
  try {
    p.kill();
  } catch {
    /* ya había terminado */
  }
}

handle('local:shells', async () => (await listShells()).map(({ id, name }) => ({ id, name })));

handle('local:open', async (_e, { connId, shellId, cols, rows }) => {
  if (typeof connId !== 'string' || conns.has(connId) || locals.has(connId)) throw new Error('Pestaña no válida');
  const p = await openShell(String(shellId), cols, rows);
  locals.set(connId, p);
  p.onData((d) => send('ssh:data', connId, d));
  p.onExit(() => {
    if (locals.get(connId) !== p) return;
    locals.delete(connId);
    send('ssh:closed', connId);
  });
  return { ok: true };
});

// ---------- SFTP ----------

const rpath = path.posix;
const promisify = (fn) => new Promise((res, rej) => fn((err, v) => (err ? rej(err) : res(v))));

// Con "sudo", el servidor ejecuta sftp-server como root (igual que la opción de WinSCP).
// Requiere sudo sin contraseña, que es lo normal en EC2 con el usuario ubuntu.
const SUDO_SFTP =
  "sudo -n sh -c 'for p in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server " +
  '/usr/lib/ssh/sftp-server /usr/libexec/sftp-server; do [ -x "$p" ] && exec "$p"; done; ' +
  "echo sftp-server no encontrado >&2; exit 127'";

function openSftp(c) {
  return new Promise((res, rej) => {
    const proto = c.client._protocol;
    const original = proto.subsystem;
    if (c.sudo) {
      // ssh2 solo abre SFTP como "subsystem": se cambia esa única petición por el comando con sudo.
      // Depende de la versión exacta de ssh2 fijada en package.json.
      proto.subsystem = function (chan, _name, wantReply) {
        proto.subsystem = original;
        return proto.exec(chan, SUDO_SFTP, wantReply);
      };
    }
    try {
      c.client.sftp((err, sftp) => {
        proto.subsystem = original;
        if (err) {
          return rej(
            c.sudo
              ? new Error('No se pudo abrir SFTP con sudo: el usuario necesita sudo sin contraseña en el servidor.')
              : err
          );
        }
        res(sftp);
      });
    } catch (err) {
      proto.subsystem = original;
      rej(err);
    }
  });
}

function getSftp(connId) {
  const c = conns.get(connId);
  if (!c) return Promise.reject(new Error('Sin conexión'));
  // Una sola apertura aunque lleguen varias operaciones a la vez.
  if (!c.sftpPromise) {
    c.sftpPromise = openSftp(c).then(
      (sftp) => {
        c.sftp = sftp;
        sftp.on('close', () => {
          if (c.sftp === sftp) {
            c.sftp = null;
            c.sftpPromise = null;
          }
        });
        return sftp;
      },
      (err) => {
        c.sftpPromise = null;
        throw err;
      }
    );
  }
  return c.sftpPromise;
}

const progress = (connId, name) => ({
  step: (done, _chunk, total) => send('sftp:progress', connId, name, done, total),
});

const statOrNull = (s, p) => promisify((cb) => s.stat(p, cb)).catch(() => null);

// Sube un archivo. Con sudo, lo nuevo quedaría de root: se le da el dueño que ya tenía
// el archivo o, si es nuevo, el de su carpeta (por ejemplo www-data).
async function putFile(id, local, remote, name) {
  const c = conns.get(id);
  const s = await getSftp(id);
  const owner = c?.sudo ? (await statOrNull(s, remote)) || (await statOrNull(s, rpath.dirname(remote))) : null;
  await promisify((cb) => s.fastPut(local, remote, progress(id, name), cb));
  if (owner) await promisify((cb) => s.chown(remote, owner.uid, owner.gid, cb)).catch(() => {});
}

handle('sftp:setSudo', async (_e, id, on) => {
  const c = conns.get(id);
  if (!c) throw new Error('Sin conexión');
  c.sudo = !!on;
  // Se cierra el canal actual; la próxima operación abre uno nuevo con el modo elegido.
  if (c.sftp) c.sftp.end();
  c.sftp = null;
  c.sftpPromise = null;
  const list = loadSessions();
  const s = list.find((x) => x.id === c.sessionId);
  if (s) {
    s.sftpSudo = c.sudo;
    writeJson(sessionsFile(), list);
  }
  return c.sudo;
});

handle('sftp:home', async (_e, id) => {
  const s = await getSftp(id);
  return promisify((cb) => s.realpath('.', cb));
});

handle('sftp:list', async (_e, id, dir) => {
  const s = await getSftp(id);
  const items = await promisify((cb) => s.readdir(dir, cb));
  return items
    .map((i) => ({
      name: i.filename,
      isDir: i.attrs.isDirectory(),
      isLink: i.attrs.isSymbolicLink(),
      size: i.attrs.size,
      mtime: i.attrs.mtime * 1000,
    }))
    .sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name));
});

handle('sftp:download', async (_e, id, remotePath) => {
  const s = await getSftp(id);
  const name = safeName(rpath.basename(remotePath));
  const r = await dialog.showSaveDialog(win, {
    title: 'Guardar archivo',
    defaultPath: path.join(app.getPath('downloads'), name),
  });
  if (r.canceled) return false;
  await promisify((cb) => s.fastGet(remotePath, r.filePath, progress(id, name), cb));
  return r.filePath;
});

async function uploadPaths(id, remoteDir, localPaths) {
  for (const p of localPaths) {
    const name = path.basename(p);
    await putFile(id, p, rpath.join(remoteDir, name), name);
  }
  return localPaths.length;
}

handle('sftp:upload', async (_e, id, remoteDir) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Subir archivos',
    properties: ['openFile', 'multiSelections'],
  });
  if (r.canceled) return 0;
  return uploadPaths(id, remoteDir, r.filePaths);
});

// Archivos arrastrados a la ventana. El puente solo puede obtener rutas de archivos que
// el usuario soltó de verdad; aun así se verifica que cada uno exista y sea un archivo.
handle('sftp:uploadDropped', (_e, id, remoteDir, localPaths) => {
  if (!Array.isArray(localPaths)) throw new Error('Solicitud inválida');
  const files = localPaths.filter((p) => typeof p === 'string' && path.isAbsolute(p) && fs.statSync(p, { throwIfNoEntry: false })?.isFile());
  return uploadPaths(id, remoteDir, files);
});

handle('sftp:mkdir', async (_e, id, p) => {
  const c = conns.get(id);
  const s = await getSftp(id);
  const owner = c?.sudo ? await statOrNull(s, rpath.dirname(p)) : null;
  await promisify((cb) => s.mkdir(p, cb));
  if (owner) await promisify((cb) => s.chown(p, owner.uid, owner.gid, cb)).catch(() => {});
});

handle('sftp:remove', async (_e, id, p, isDir) => {
  const s = await getSftp(id);
  await promisify((cb) => (isDir ? s.rmdir(p, cb) : s.unlink(p, cb)));
});

handle('sftp:rename', async (_e, id, from, to) => {
  const s = await getSftp(id);
  await promisify((cb) => s.rename(from, to, cb));
});

// ---------- Editar archivos remotos (como WinSCP) ----------
// Se descarga una copia temporal, se abre en el editor y cada vez que se guarda se sube sola.

const editBase = path.join(os.tmpdir(), 'mi-terminal-edit');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const VSCODE_PATHS = [
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
  path.join(process.env.ProgramFiles || '', 'Microsoft VS Code', 'Code.exe'),
];

// Un nombre del servidor puede traer caracteres que Windows no acepta (o "\", que crearía subcarpetas).
const safeName = (n) => n.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '_') || 'archivo';

// Editor: el elegido por el usuario, si no VS Code si está instalado, si no el predeterminado de Windows.
function getEditor() {
  const st = readJson(settingsFile(), {});
  if (st.editor === 'system') return null;
  if (st.editor && fs.existsSync(st.editor)) return st.editor;
  return VSCODE_PATHS.find((p) => p && fs.existsSync(p)) || null;
}

const editorName = (p) => (p ? path.basename(p, path.extname(p)) : 'Predeterminado de Windows');

handle('editor:get', () => editorName(getEditor()));

handle('editor:choose', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Elegir editor',
    defaultPath: process.env.ProgramFiles,
    filters: [{ name: 'Programas', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  if (r.canceled) return editorName(getEditor());
  writeJson(settingsFile(), { ...readJson(settingsFile(), {}), editor: r.filePaths[0] });
  return editorName(getEditor());
});

handle('editor:useSystem', () => {
  writeJson(settingsFile(), { ...readJson(settingsFile(), {}), editor: 'system' });
  return editorName(getEditor());
});

handle('sftp:edit', async (_e, id, remotePath) => {
  const c = conns.get(id);
  if (!c) throw new Error('Sin conexión');
  const s = await getSftp(id);
  const name = safeName(rpath.basename(remotePath));

  const previous = c.edits.get(remotePath);
  if (previous) fs.unwatchFile(previous.local);

  const dir = path.join(editBase, id, crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  const local = path.join(dir, name);
  await promisify((cb) => s.fastGet(remotePath, local, progress(id, name), cb));

  const entry = { local, mtime: fs.statSync(local).mtimeMs, timer: null, queue: Promise.resolve() };
  c.edits.set(remotePath, entry);

  fs.watchFile(local, { interval: 700 }, (cur) => {
    if (!cur.mtimeMs || cur.mtimeMs === entry.mtime) return;
    entry.mtime = cur.mtimeMs;
    clearTimeout(entry.timer);
    // Espera un momento por si el editor guarda en varias escrituras.
    entry.timer = setTimeout(() => {
      entry.queue = entry.queue
        .then(() => putFile(id, local, remotePath, name))
        .then(
          () => send('sftp:edited', id, remotePath, null),
          (err) => send('sftp:edited', id, remotePath, err.message)
        );
    }, 400);
  });

  const editor = getEditor();
  if (editor) {
    spawn(editor, [local], { detached: true, stdio: 'ignore' }).unref();
  } else {
    // Con el programa predeterminado de Windows, un archivo .bat, .exe, .js, etc. se ejecutaría.
    // Un servidor comprometido podría aprovecharlo, así que esos tipos nunca se abren así.
    if (isRunnable(name)) {
      stopEdit(c, remotePath);
      throw new Error(
        `"${name}" es de un tipo que Windows ejecutaría en vez de abrir. Por seguridad no se abre: ` +
          'elige un editor (botón Editor) o usa "Descargar".'
      );
    }
    const err = await shell.openPath(local);
    if (err) throw new Error(`Windows no sabe con qué abrir "${name}". Elige un editor en el panel SFTP.`);
  }
  return editorName(editor);
});

// Tipos que Windows ejecuta (o que lanzan otro programa) al abrirlos con doble clic.
const RUNNABLE_EXT = new Set(
  (
    'exe com scr pif cpl msi msp mst msc bat cmd ps1 ps1xml psc1 psd1 psm1 vbs vbe js jse wsf wsh ws ' +
    'hta lnk url reg inf scf jar appref-ms application gadget chm hlp sct shb shs xbap settingcontent-ms ' +
    'library-ms search-ms searchconnector-ms diagcab appx appxbundle msix msixbundle py pyw pyz rb pl ' +
    'iso img vhd vhdx dll ocx sys drv lib job'
  ).split(' ')
);
const isRunnable = (name) => {
  const ext = path.extname(name).slice(1).toLowerCase();
  return !ext || RUNNABLE_EXT.has(ext);
};

function stopEdit(c, remotePath) {
  const e = c.edits.get(remotePath);
  if (!e) return;
  fs.unwatchFile(e.local);
  clearTimeout(e.timer);
  c.edits.delete(remotePath);
  fs.rm(path.dirname(e.local), { recursive: true, force: true }, () => {});
}

function stopEdits(connId, c) {
  for (const e of c.edits.values()) {
    fs.unwatchFile(e.local);
    clearTimeout(e.timer);
  }
  c.edits.clear();
  fs.rm(path.join(editBase, connId), { recursive: true, force: true }, () => {});
}

app.on('will-quit', () => fs.rmSync(editBase, { recursive: true, force: true }));

// ---------- Ventana ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#1e1e1e',
    title: 'Mi Terminal',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  // Copias temporales que hayan quedado de un cierre inesperado.
  fs.rmSync(editBase, { recursive: true, force: true });

  // La app no usa cámara, micrófono, ubicación, notificaciones, etc.
  const ses = require('electron').session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);

  createWindow();
});

// Ninguna ventana o vista puede crearse ni navegar fuera de la app.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

app.on('window-all-closed', () => {
  for (const c of conns.values()) c.client.end();
  for (const id of [...locals.keys()]) closeLocal(id);
  app.quit();
});
