// Interfaz: gestor de sesiones, pestañas de terminal y explorador SFTP.
const $ = (sel) => document.querySelector(sel);

let sessions = [];
const tabs = new Map(); // connId -> pestaña
let activeId = null;
let sftpVisible = false;
let counter = 0;

const cleanErr = (e) =>
  String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const status = (msg) => ($('#statusbar').textContent = msg);

// ---------- Árbol de sesiones ----------

async function refreshSessions() {
  sessions = await api.listSessions();
  renderTree();
}

function renderTree() {
  const tree = $('#session-tree');
  tree.replaceChildren();
  const q = $('#filter').value.trim().toLowerCase();

  const groups = new Map();
  for (const s of sessions) {
    const text = `${s.name} ${s.host} ${s.username} ${s.folder}`.toLowerCase();
    if (q && !text.includes(q)) continue;
    const f = s.folder || '';
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(s);
  }

  const folders = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  for (const f of folders) {
    let container = tree;
    if (f) {
      const d = document.createElement('details');
      d.open = true;
      const sum = document.createElement('summary');
      sum.textContent = f;
      d.append(sum);
      tree.append(d);
      container = d;
    }
    for (const s of groups.get(f).sort((a, b) => a.name.localeCompare(b.name))) {
      const item = document.createElement('div');
      item.className = 'session';
      item.title = `${s.username}@${s.host}:${s.port}`;
      const name = document.createElement('span');
      name.textContent = s.name;
      const sub = document.createElement('small');
      sub.textContent = `${s.username}@${s.host}`;
      item.append(name, sub);
      item.ondblclick = () => openSession(s);
      item.oncontextmenu = (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          ['Conectar', () => openSession(s)],
          ['Editar', () => editSession(s)],
          ['Duplicar', () => editSession({ ...s, id: undefined, name: `${s.name} (copia)`, hasPassword: false, hasPassphrase: false })],
          ['Eliminar', () => removeSession(s)],
        ]);
      };
      container.append(item);
    }
  }

  if (!tree.childElementCount) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = sessions.length ? 'Sin resultados.' : 'No hay sesiones. Pulsa + para crear una.';
    tree.append(p);
  }
}

async function removeSession(s) {
  if (!confirm(`¿Eliminar la sesión "${s.name}"?`)) return;
  await api.deleteSession(s.id);
  refreshSessions();
}

$('#filter').oninput = renderTree;
$('#btn-new').onclick = () => editSession();

// ---------- Menú contextual ----------

function showMenu(x, y, items) {
  const m = $('#ctx-menu');
  m.replaceChildren();
  for (const [label, fn] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => {
      hideMenu();
      fn();
    };
    m.append(b);
  }
  m.hidden = false;
  m.style.left = `${Math.min(x, innerWidth - m.offsetWidth - 4)}px`;
  m.style.top = `${Math.min(y, innerHeight - m.offsetHeight - 4)}px`;
}
const hideMenu = () => ($('#ctx-menu').hidden = true);
document.addEventListener('click', hideMenu);
document.addEventListener('keydown', (e) => e.key === 'Escape' && hideMenu());

// ---------- Editor de sesión ----------

const dlg = $('#session-dialog');
const form = $('#session-form');
let editing = null;

function editSession(s = {}) {
  editing = s;
  form.reset();
  $('#f-title').textContent = s.id ? 'Editar sesión' : 'Nueva sesión';
  const f = form.elements;
  for (const k of ['name', 'folder', 'host', 'username', 'keyPath']) f[k].value = s[k] || '';
  f.port.value = s.port || 22;
  f.authType.value = s.authType || 'password';
  f.password.placeholder = s.hasPassword ? 'Guardada; escribe para cambiarla' : 'Opcional; si no, se pide al conectar';
  f.passphrase.placeholder = s.hasPassphrase ? 'Guardada; escribe para cambiarla' : 'Opcional';
  $('#tunnel-rows').replaceChildren();
  (s.tunnels || []).forEach(addTunnelRow);
  updateAuthFields();
  dlg.showModal();
}

function updateAuthFields() {
  const t = form.elements.authType.value;
  $('#auth-password').hidden = t !== 'password';
  $('#auth-key').hidden = t !== 'key';
}
form.elements.authType.onchange = updateAuthFields;

function addTunnelRow(t = { type: 'L', srcPort: '', dstHost: '127.0.0.1', dstPort: '' }) {
  const row = document.createElement('div');
  row.className = 'tunnel-row';
  row.innerHTML = `
    <select data-k="type"><option value="L">Local</option><option value="R">Remoto</option></select>
    <input data-k="srcPort" type="number" min="1" max="65535" placeholder="Puerto origen" required>
    <input data-k="dstHost" placeholder="Host destino" required>
    <input data-k="dstPort" type="number" min="1" max="65535" placeholder="Puerto destino" required>
    <button type="button" title="Quitar túnel">✕</button>`;
  for (const el of row.querySelectorAll('[data-k]')) el.value = t[el.dataset.k] ?? '';
  row.querySelector('button').onclick = () => row.remove();
  $('#tunnel-rows').append(row);
}

form.onsubmit = async (e) => {
  e.preventDefault();
  const f = form.elements;
  const val = (row, k) => row.querySelector(`[data-k=${k}]`).value.trim();
  const data = {
    id: editing?.id,
    name: f.name.value.trim(),
    folder: f.folder.value.trim(),
    host: f.host.value.trim(),
    port: Number(f.port.value) || 22,
    username: f.username.value.trim(),
    authType: f.authType.value,
    keyPath: f.keyPath.value.trim(),
    tunnels: [...document.querySelectorAll('.tunnel-row')].map((r) => ({
      type: val(r, 'type'),
      srcPort: Number(val(r, 'srcPort')),
      dstHost: val(r, 'dstHost'),
      dstPort: Number(val(r, 'dstPort')),
    })),
  };
  if (f.clearSecrets.checked) {
    data.password = '';
    data.passphrase = '';
  } else {
    if (f.password.value) data.password = f.password.value;
    if (f.passphrase.value) data.passphrase = f.passphrase.value;
  }
  try {
    await api.saveSession(data);
    dlg.close();
    refreshSessions();
  } catch (err) {
    alert(cleanErr(err));
  }
};

$('#f-cancel').onclick = () => dlg.close();
$('#f-add-tunnel').onclick = () => addTunnelRow();
$('#f-browse').onclick = async () => {
  const p = await api.pickKey();
  if (p) form.elements.keyPath.value = p;
};

// ---------- Diálogo de texto / contraseña ----------

// Hay un solo diálogo: las preguntas van en fila, una a la vez, para que lo que
// escribes para un servidor nunca termine en otro.
let askQueue = Promise.resolve();

function ask(title, label, opts) {
  const run = askQueue.then(() => askNow(title, label, opts));
  askQueue = run.catch(() => {});
  return run;
}

function askNow(title, label, { secret = true, value = '' } = {}) {
  return new Promise((resolve) => {
    const d = $('#prompt-dialog');
    const inp = $('#p-input');
    $('#p-title').textContent = title;
    $('#p-label').textContent = label;
    inp.type = secret ? 'password' : 'text';
    inp.value = value;
    d.showModal();
    inp.focus();
    inp.select();
    $('#p-form').onsubmit = (e) => {
      e.preventDefault();
      d.close();
      resolve(inp.value);
    };
    $('#p-cancel').onclick = () => {
      d.close();
      resolve(null);
    };
    d.oncancel = () => resolve(null);
  });
}

// ---------- Pestañas de terminal ----------

const openSession = (s) => openTab(s.name, { session: s });

// Consola de este equipo (CMD, PowerShell, WSL…) en una pestaña.
const openLocal = (shell) => openTab(shell.name, { local: shell, noStats: true });

$('#btn-local').onclick = async (e) => {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  try {
    const shells = await api.local.shells();
    showMenu(r.left, r.bottom + 2, shells.map((sh) => [sh.name, () => openLocal(sh)]));
  } catch (err) {
    status(`No se pudieron listar las consolas: ${cleanErr(err)}`);
  }
};

function openTab(name, extra) {
  const connId = `c${Date.now()}-${++counter}`;
  const el = document.createElement('div');
  el.className = 'term';
  $('#terminals').append(el);

  const term = new Terminal({
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: 14,
    cursorBlink: true,
    scrollback: 10000,
    theme: { background: '#1e1e1e' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  enableWebgl(term);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  const label = document.createElement('span');
  label.textContent = name;
  if (extra.local) tabEl.classList.add('local');
  const close = document.createElement('button');
  close.textContent = '✕';
  close.title = 'Cerrar pestaña';
  tabEl.append(label, close);
  $('#tabs').append(tabEl);

  const tab = { connId, term, fit, el, tabEl, alive: false, sftpPath: null, ...extra };
  tabs.set(connId, tab);

  tabEl.onclick = () => activate(connId);
  close.onclick = (e) => {
    e.stopPropagation();
    closeTab(connId);
  };

  term.onData((d) => {
    if (tab.alive) api.write(connId, d);
    else if (tab.awaitReconnect && d === '\r') {
      tab.awaitReconnect = false;
      connectTab(tab);
    }
  });

  // Copiar al seleccionar, pegar con clic derecho o Ctrl+Shift+V.
  term.onSelectionChange(() => {
    const t = term.getSelection();
    if (t) api.clipboard.write(t);
  });
  el.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const t = await api.clipboard.read();
    if (t && tab.alive) term.paste(t);
  });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
    if (e.code === 'KeyC') {
      const t = term.getSelection();
      if (t) api.clipboard.write(t);
      return false;
    }
    if (e.code === 'KeyV') {
      api.clipboard.read().then((t) => t && tab.alive && term.paste(t));
      return false;
    }
    return true;
  });

  activate(connId);
  connectTab(tab);
}

// Dibuja con la tarjeta gráfica (mucho más rápido). Si WebGL falla, xterm vuelve al modo normal.
function enableWebgl(term) {
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    /* sin WebGL: se usa el renderizado por defecto */
  }
}

async function connectLocal(tab) {
  fitTab(tab);
  try {
    await api.local.open({ connId: tab.connId, shellId: tab.local.id, cols: tab.term.cols, rows: tab.term.rows });
    tab.alive = true;
    tab.tabEl.classList.remove('dead');
    if (activeId === tab.connId) tab.term.focus();
  } catch (err) {
    markClosed(tab, `Error: ${cleanErr(err)}`);
  }
}

async function connectTab(tab, secret, retried = false) {
  if (tab.local) return connectLocal(tab);
  // Usa los datos más recientes de la sesión por si se editó con la pestaña abierta.
  const s = (tab.session = sessions.find((x) => x.id === tab.session.id) || tab.session);
  fitTab(tab);
  tab.term.writeln(`\x1b[90mConectando a ${s.username}@${s.host}:${s.port}…\x1b[0m`);

  if (secret === undefined && s.authType === 'password' && !s.hasPassword) {
    secret = await ask('Contraseña', `Contraseña para ${s.username}@${s.host}`);
    if (secret === null) return markClosed(tab, 'Conexión cancelada.');
  }

  try {
    await api.connect({
      connId: tab.connId,
      sessionId: s.id,
      password: secret,
      cols: tab.term.cols,
      rows: tab.term.rows,
    });
    tab.alive = true;
    tab.tabEl.classList.remove('dead');
    tab.noStats = false;
    // Si el servidor no entrega estadísticas en 10 s (p. ej. no permite comandos extra), se oculta la barra.
    setTimeout(() => {
      if (tab.alive && !tab.stats) {
        tab.noStats = true;
        if (activeId === tab.connId) renderStats();
      }
    }, 10000);
    if (activeId === tab.connId) renderStats();
    if (activeId === tab.connId) {
      tab.term.focus();
      if (sftpVisible) loadSftp();
    }
  } catch (err) {
    const msg = cleanErr(err);
    const isKey = s.authType === 'key';
    const canRetry = isKey ? /passphrase/i.test(msg) : s.authType === 'password' && /authentication methods failed/i.test(msg);
    if (!retried && canRetry) {
      tab.term.writeln(`\x1b[33m${msg}\x1b[0m`);
      const v = await ask(
        isKey ? 'Frase de paso' : 'Contraseña',
        isKey ? `Frase de paso de ${s.keyPath}` : `Contraseña para ${s.username}@${s.host}`
      );
      if (v !== null) return connectTab(tab, v, true);
    }
    markClosed(tab, `Error: ${msg}`);
  }
}

function markClosed(tab, msg) {
  tab.alive = false;
  tab.stats = null;
  tab.cpuHist = [];
  if (activeId === tab.connId) renderStats();
  tab.awaitReconnect = true;
  tab.tabEl.classList.add('dead');
  tab.term.writeln(`\r\n\x1b[31m${msg}\x1b[0m`);
  tab.term.writeln(`\x1b[90mPresiona Enter para ${tab.local ? 'abrirla de nuevo' : 'reconectar'}.\x1b[0m`);
  if (activeId === tab.connId && sftpVisible) loadSftp();
}

function fitTab(t) {
  try {
    t.fit.fit();
  } catch {
    /* pestaña oculta */
  }
  if (t.alive) api.resize(t.connId, t.term.cols, t.term.rows);
}

function activate(id) {
  activeId = id;
  for (const [k, t] of tabs) {
    t.el.classList.toggle('active', k === id);
    t.tabEl.classList.toggle('active', k === id);
  }
  $('#empty').hidden = tabs.size > 0;
  const t = tabs.get(id);
  if (t) {
    requestAnimationFrame(() => {
      fitTab(t);
      t.term.focus();
    });
    status(t.local ? `${t.local.name} (este equipo)` : `${t.session.username}@${t.session.host}:${t.session.port}`);
  } else {
    status('Listo');
  }
  renderStats();
  if (sftpVisible) loadSftp();
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  if (t.alive) api.disconnect(id);
  t.alive = false;
  tabs.delete(id);
  t.term.dispose();
  t.el.remove();
  t.tabEl.remove();
  if (activeId === id) activate([...tabs.keys()].pop() ?? null);
}

new ResizeObserver(() => {
  const t = tabs.get(activeId);
  if (t) fitTab(t);
}).observe($('#terminals'));

api.onData((id, d) => tabs.get(id)?.term.write(d));
api.onStatus((id, msg) => {
  tabs.get(id)?.term.writeln(`\r\n\x1b[33m${msg}\x1b[0m`);
  status(msg);
});
api.onClosed((id) => {
  const t = tabs.get(id);
  if (t?.alive) markClosed(t, t.local ? 'Consola cerrada.' : 'Conexión cerrada.');
});

// ---------- Estadísticas del servidor ----------

const CPU_POINTS = 60;
const num = (n, d = 2) => n.toLocaleString('es-CL', { minimumFractionDigits: d, maximumFractionDigits: d });
const gb = (bytes) => `${num(bytes / 1024 ** 3)} GB`;
const mbps = (bits) => `${num(bits / 1e6)} Mb/s`;
const level = (pct) => (pct >= 90 ? 'crit' : pct >= 80 ? 'warn' : '');

function uptimeText(sec) {
  const days = Math.floor(sec / 86400);
  if (days >= 1) return `${days} ${days === 1 ? 'día' : 'días'}`;
  const h = Math.floor(sec / 3600);
  return h >= 1 ? `${h} h` : `${Math.floor(sec / 60)} min`;
}

api.onStats((id, st) => {
  const t = tabs.get(id);
  if (!t || !t.alive) return;
  t.stats = st;
  t.noStats = false;
  t.cpuHist ||= [];
  if (st.cpu != null) {
    t.cpuHist.push(st.cpu);
    if (t.cpuHist.length > CPU_POINTS) t.cpuHist.shift();
  }
  if (activeId === id) renderStats();
});

function statItem(bar, label, text, { cls = '', title = '' } = {}) {
  const el = document.createElement('div');
  el.className = 'stat';
  if (title) el.title = title;
  if (label) {
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = label;
    el.append(k);
  }
  const v = document.createElement('span');
  v.className = cls;
  v.textContent = text;
  el.append(v);
  bar.append(el);
  return el;
}

function drawSpark(canvas, data) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = 70 * dpr;
  canvas.height = 18 * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  if (data.length < 2) return;
  const step = 70 / (CPU_POINTS - 1);
  const x0 = 70 - (data.length - 1) * step;
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = x0 + i * step;
    const y = 17 - (v / 100) * 16;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = '#52c052';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.lineTo(70, 18);
  ctx.lineTo(x0, 18);
  ctx.closePath();
  ctx.fillStyle = 'rgba(82, 192, 82, 0.25)';
  ctx.fill();
}

// La barra ocupa siempre una línea. Si no cabe todo, aparecen flechas para recorrerla.
const statsItems = $('#stats-items');

function updateStatArrows() {
  const max = statsItems.scrollWidth - statsItems.clientWidth;
  const x = statsItems.scrollLeft;
  // Con las flechas ya visibles se exige un margen para ocultarlas, así no parpadean.
  const overflow = max > 1 || x > 0;
  $('#stats-prev').hidden = $('#stats-next').hidden = !overflow;
  $('#stats-prev').disabled = x <= 0;
  $('#stats-next').disabled = x >= max - 1;
}

function scrollStats(dir) {
  statsItems.scrollLeft += dir * Math.max(120, statsItems.clientWidth * 0.6);
  updateStatArrows();
}
$('#stats-prev').onclick = () => scrollStats(-1);
$('#stats-next').onclick = () => scrollStats(1);
statsItems.addEventListener('wheel', (e) => {
  if (statsItems.scrollWidth <= statsItems.clientWidth) return;
  e.preventDefault();
  statsItems.scrollLeft += e.deltaY || e.deltaX;
  updateStatArrows();
}, { passive: false });
new ResizeObserver(updateStatArrows).observe(statsItems);

function renderStats() {
  // Los datos se redibujan cada 2 s: se conserva la posición en la que quedó el usuario.
  const x = activeId === statsItems.dataset.tab ? statsItems.scrollLeft : 0;
  statsItems.dataset.tab = activeId ?? '';
  drawStats();
  statsItems.scrollLeft = x;
  updateStatArrows();
}

function drawStats() {
  const wrap = $('#statsbar');
  const bar = statsItems;
  const t = tabs.get(activeId);
  const st = t?.alive ? t.stats : null;
  bar.replaceChildren();
  if (!st) {
    wrap.hidden = !t?.alive || t.noStats;
    if (t?.alive) statItem(bar, '', 'Leyendo estadísticas del servidor…', { cls: 'wait' });
    return;
  }
  wrap.hidden = false;

  statItem(bar, '', st.host || t.session.host, { cls: 'host', title: `${t.session.username}@${t.session.host}` });

  const cpu = statItem(bar, 'CPU', st.cpu == null ? '…' : `${Math.round(st.cpu)}%`, {
    cls: st.cpu == null ? 'wait' : level(st.cpu),
    title: 'Uso de CPU (últimos 2 minutos)',
  });
  const canvas = document.createElement('canvas');
  cpu.append(canvas);
  drawSpark(canvas, t.cpuHist || []);

  const memPct = st.memTotal ? (st.memUsed / st.memTotal) * 100 : 0;
  statItem(bar, 'RAM', `${gb(st.memUsed)} / ${gb(st.memTotal)}`, {
    cls: level(memPct),
    title: `Memoria en uso: ${Math.round(memPct)}%`,
  });
  statItem(bar, '↑', st.up == null ? '…' : mbps(st.up), { title: 'Subida (enviado por el servidor)' });
  statItem(bar, '↓', st.down == null ? '…' : mbps(st.down), { title: 'Bajada (recibido por el servidor)' });
  statItem(bar, 'Encendido', uptimeText(st.uptime), { title: 'Tiempo desde el último reinicio' });

  if (st.users.length) {
    const text = st.users.map((u) => (u.count > 1 ? `${u.name} (x${u.count})` : u.name)).join(', ');
    statItem(bar, 'Usuarios', text, { title: 'Sesiones abiertas en el servidor' });
  }
  for (const d of st.disks) {
    statItem(bar, d.mount, `${d.pct}%`, { cls: level(d.pct), title: `Disco montado en ${d.mount}: ${d.pct}% usado` });
  }
}

// ---------- Explorador SFTP ----------

const join = (dir, name) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);
const parent = (p) => (p === '/' ? '/' : p.replace(/\/[^/]+\/?$/, '') || '/');
const sftpMsg = (m) => ($('#sftp-status').textContent = m);

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(1)} ${u[i]}`;
}

function activeSftpTab() {
  const t = tabs.get(activeId);
  return t?.alive && t.session ? t : null;
}

async function loadSftp(dir) {
  const list = $('#sftp-list');
  const t = activeSftpTab();
  if (!t) {
    list.replaceChildren();
    $('#sftp-path').value = '';
    sftpMsg(tabs.get(activeId)?.local ? 'Las consolas locales no usan SFTP.' : 'Conéctate a una sesión para ver sus archivos.');
    return;
  }
  syncSudo(t);
  try {
    if (dir) t.sftpPath = dir;
    if (!t.sftpPath) t.sftpPath = await api.sftp.home(t.connId);
    const items = await api.sftp.list(t.connId, t.sftpPath);
    if (activeId !== t.connId) return;
    $('#sftp-path').value = t.sftpPath;
    list.replaceChildren();
    for (const it of items) {
      if (it.name === '.' || it.name === '..') continue;
      list.append(sftpItem(t, it));
    }
    sftpMsg(`${items.length} elementos`);
  } catch (err) {
    sftpFail('Error', err);
  }
}

function sftpItem(t, it) {
  const full = join(t.sftpPath, it.name);
  const li = document.createElement('li');
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = `${it.isDir ? '📁' : it.isLink ? '🔗' : '📄'} ${it.name}`;
  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = it.isDir ? '' : fmtSize(it.size);
  li.title = `${it.name}\n${new Date(it.mtime).toLocaleString()}`;
  li.append(name, size);

  const open = async () => {
    if (it.isDir) return loadSftp(full);
    if (it.isLink) {
      try {
        await api.sftp.list(t.connId, full);
        return loadSftp(full);
      } catch {
        /* no es carpeta: descargar */
      }
    }
    editFile(t, full);
  };
  li.ondblclick = open;
  li.oncontextmenu = (e) => {
    e.preventDefault();
    const items = it.isDir
      ? [['Abrir', open]]
      : [
          ['Abrir / editar', () => editFile(t, full)],
          ['Descargar', () => download(t, full)],
        ];
    showMenu(e.clientX, e.clientY, [
      ...items,
      ['Renombrar', () => renameItem(t, it.name)],
      ['Eliminar', () => removeItem(t, it)],
    ]);
  };
  return li;
}

// Muestra un error de SFTP; si es falta de permisos, sugiere el modo sudo.
function sftpFail(prefix, err) {
  const msg = cleanErr(err);
  const t = activeSftpTab();
  const hint =
    /permission denied/i.test(msg) && t && !t.session.sftpSudo
      ? ' — tu usuario no tiene permiso en esa carpeta. Activa "sudo" aquí abajo o revisa los permisos en el servidor.'
      : '';
  sftpMsg(`${prefix}: ${msg}${hint}`);
}

// Abre el archivo en el editor; al guardarlo en el editor se sube solo al servidor.
async function editFile(t, remote) {
  const name = remote.split('/').pop();
  sftpMsg(`Abriendo ${name}…`);
  try {
    const editor = await api.sftp.edit(t.connId, remote);
    sftpMsg(`${name} abierto en ${editor}. Cada vez que guardes, se sube solo al servidor.`);
  } catch (err) {
    sftpFail('Error al abrir', err);
  }
}

api.onEdited((id, remote, error) => {
  const name = remote.split('/').pop();
  const time = new Date().toLocaleTimeString('es-CL');
  const msg = error ? `No se pudo subir ${name} (${time}): ${error}` : `${name} subido al servidor (${time})`;
  if (activeId === id) {
    if (error) sftpFail(`No se pudo subir ${name}`, error);
    else sftpMsg(msg);
  }
  status(msg);
});

async function download(t, remote) {
  try {
    const saved = await api.sftp.download(t.connId, remote);
    if (saved) sftpMsg(`Guardado en ${saved}`);
  } catch (err) {
    sftpFail('Error al descargar', err);
  }
}

async function renameItem(t, oldName) {
  const n = await ask('Renombrar', 'Nuevo nombre', { secret: false, value: oldName });
  if (!n || n === oldName) return;
  try {
    await api.sftp.rename(t.connId, join(t.sftpPath, oldName), join(t.sftpPath, n));
    loadSftp();
  } catch (err) {
    sftpFail('Error', err);
  }
}

async function removeItem(t, it) {
  const what = it.isDir ? 'la carpeta (debe estar vacía)' : 'el archivo';
  if (!confirm(`¿Eliminar ${what} "${it.name}"?`)) return;
  try {
    await api.sftp.remove(t.connId, join(t.sftpPath, it.name), it.isDir);
    loadSftp();
  } catch (err) {
    sftpFail('Error', err);
  }
}

$('#btn-sftp').onclick = () => {
  sftpVisible = !sftpVisible;
  $('#sftp').hidden = !sftpVisible;
  $('#split-right').hidden = !sftpVisible;
  if (sftpVisible) dispatchEvent(new Event('resize')); // ajusta el ancho guardado al espacio disponible
  $('#btn-sftp').classList.toggle('on', sftpVisible);
  if (sftpVisible) loadSftp();
};
$('#sftp-refresh').onclick = () => loadSftp();
$('#sftp-up').onclick = () => {
  const t = activeSftpTab();
  if (t?.sftpPath) loadSftp(parent(t.sftpPath));
};
$('#sftp-path').onkeydown = (e) => {
  if (e.key === 'Enter') loadSftp(e.target.value.trim() || '/');
};

function syncSudo(t) {
  const on = !!t?.session.sftpSudo;
  $('#sftp-sudo').checked = on;
  $('#sftp-sudo').disabled = !t;
  $('#sftp-sudo').parentElement.classList.toggle('on', on);
}

$('#sftp-sudo').onchange = async (e) => {
  const t = activeSftpTab();
  if (!t) return;
  const on = e.target.checked;
  if (on && !confirm('Con sudo, SFTP trabaja como administrador (root) en este servidor: puedes modificar o borrar cualquier archivo, incluidos los del sistema.\n\nLos archivos nuevos quedan con el dueño de su carpeta.\n\n¿Activar sudo para esta sesión?')) {
    e.target.checked = false;
    return;
  }
  try {
    await api.sftp.setSudo(t.connId, on);
    t.session.sftpSudo = on;
    const s = sessions.find((x) => x.id === t.session.id);
    if (s) s.sftpSudo = on;
    syncSudo(t);
    await loadSftp();
    if (on && !$('#sftp-status').textContent.startsWith('Error')) sftpMsg('SFTP con sudo activo.');
  } catch (err) {
    sftpFail('Error', err);
  }
};

async function refreshEditorLabel(name) {
  $('#sftp-editor').textContent = `Editor: ${name ?? (await api.editor.get())}`;
}
$('#sftp-editor').onclick = (e) => {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(r.left, r.bottom + 2, [
    ['Elegir programa…', async () => refreshEditorLabel(await api.editor.choose())],
    ['Usar el predeterminado de Windows', async () => refreshEditorLabel(await api.editor.useSystem())],
  ]);
};
refreshEditorLabel();

$('#sftp-upload').onclick = async () => {
  const t = activeSftpTab();
  if (!t) return;
  try {
    const n = await api.sftp.upload(t.connId, t.sftpPath);
    if (n) {
      sftpMsg(`${n} archivo(s) subido(s)`);
      loadSftp();
    }
  } catch (err) {
    sftpFail('Error al subir', err);
  }
};

$('#sftp-mkdir').onclick = async () => {
  const t = activeSftpTab();
  if (!t) return;
  const n = await ask('Nueva carpeta', 'Nombre', { secret: false });
  if (!n) return;
  try {
    await api.sftp.mkdir(t.connId, join(t.sftpPath, n));
    loadSftp();
  } catch (err) {
    sftpFail('Error', err);
  }
};

// Arrastrar archivos desde Windows al panel para subirlos.
const dropZone = $('#sftp-list');
dropZone.ondragover = (e) => {
  e.preventDefault();
  dropZone.classList.add('drop');
};
dropZone.ondragleave = () => dropZone.classList.remove('drop');
dropZone.ondrop = async (e) => {
  e.preventDefault();
  dropZone.classList.remove('drop');
  const t = activeSftpTab();
  if (!t) return;
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  try {
    const n = await api.sftp.uploadDropped(t.connId, t.sftpPath, files);
    sftpMsg(`${n} archivo(s) subido(s)`);
    loadSftp();
  } catch (err) {
    sftpFail('Error al subir', err);
  }
};

api.onProgress((_id, name, done, total) => {
  sftpMsg(`${name}: ${total ? Math.round((done / total) * 100) : 0}%`);
});

// ---------- Ancho de los paneles (sesiones y SFTP) ----------
// Se arrastra el divisor; el ancho elegido se recuerda. Doble clic vuelve al tamaño original.

const MIN_TERMINAL = 320; // la terminal nunca queda más angosta que esto

function makeResizable(splitter, panel, { key, side, def, min, max }) {
  const store = {
    get: () => {
      try {
        return Number(localStorage.getItem(key)) || null;
      } catch {
        return null;
      }
    },
    set: (v) => {
      try {
        localStorage.setItem(key, String(v));
      } catch {
        /* sin almacenamiento: solo dura esta sesión */
      }
    },
  };
  const clamp = (w) => {
    const other = panel === $('#sidebar') ? ($('#sftp').hidden ? 0 : $('#sftp').offsetWidth) : $('#sidebar').offsetWidth;
    const room = innerWidth - other - 10 - MIN_TERMINAL;
    return Math.round(Math.max(min, Math.min(w, max, room)));
  };
  const apply = (w) => (panel.style.width = `${clamp(w)}px`);
  apply(store.get() || def);

  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('dragging');
    document.body.classList.add('resizing');
    const startX = e.clientX;
    const startW = panel.offsetWidth;
    const move = (ev) => apply(side === 'left' ? startW + (ev.clientX - startX) : startW - (ev.clientX - startX));
    const up = () => {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.removeEventListener('pointercancel', up);
      splitter.classList.remove('dragging');
      document.body.classList.remove('resizing');
      store.set(panel.offsetWidth);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
    splitter.addEventListener('pointercancel', up);
  });
  splitter.addEventListener('dblclick', () => {
    apply(def);
    store.set(def);
  });
  // Si la ventana se achica, los paneles se ajustan para no tapar la terminal.
  addEventListener('resize', () => apply(store.get() || def));
}

makeResizable($('#split-left'), $('#sidebar'), { key: 'width.sessions', side: 'left', def: 240, min: 160, max: 600 });
makeResizable($('#split-right'), $('#sftp'), { key: 'width.sftp', side: 'right', def: 320, min: 220, max: 1000 });

// Evita que soltar un archivo fuera del panel abra el archivo en la ventana.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

refreshSessions();
