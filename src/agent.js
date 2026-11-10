// Herramientas que un agente (Cursor, Codex, Claude…) puede usar por MCP.
// Reglas:
//  - Solo ve sesiones marcadas "Permitir agentes" (y consolas locales si el usuario lo activó).
//  - Cada acción se aprueba en un diálogo de la app que muestra el texto exacto, salvo que
//    el usuario haya elegido "Permitir todo en esta pestaña".
//  - Nunca recibe contraseñas, frases de paso ni claves.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const MAX_CMD = 2000; // un comando debe caber completo en el diálogo de aprobación
const MAX_OUT = 30000;
const MAX_FILE = 512 * 1024;

const KEYS = {
  enter: '\r',
  tab: '\t',
  esc: '\x1b',
  space: ' ',
  'ctrl+c': '\x03',
  'ctrl+d': '\x04',
  'ctrl+z': '\x1a',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (text) => (text.length > MAX_OUT ? `… (salida recortada)\n${text.slice(-MAX_OUT)}` : text);
const str = (v, name, max = 1000) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Falta "${name}".`);
  if (v.length > max) throw new Error(`"${name}" es demasiado largo (máximo ${max} caracteres).`);
  return v;
};
const REJECTED = 'El usuario rechazó la solicitud o no respondió a tiempo. No la repitas sin consultarle.';
const REJECTED_HINT =
  ' Si el usuario no vio ninguna pregunta, su agente rechaza estas solicitudes automáticamente: ' +
  'puede elegir "Aprobar en Mi Terminal" en el panel MCP de la app.';

module.exports = function createAgent(ctx) {
  const perms = new Map(); // connId -> { read, all }
  const busy = new Set(); // pestañas con un comando del agente en curso
  let queue = Promise.resolve(); // un solo diálogo a la vez
  const plainClients = new Set(); // agentes conectados que no muestran formularios con campos
  const HUMAN_MS = 1500; // nadie lee y responde una pregunta en menos de esto
  const call = new AsyncLocalStorage(); // datos de la llamada MCP en curso (cómo preguntar al usuario)

  const perm = (id) => {
    if (!perms.has(id)) perms.set(id, { read: false, all: false });
    return perms.get(id);
  };

  // ---------- Qué puede ver el agente ----------

  const allowedSessions = () => ctx.loadSessions().filter((s) => s.allowAgents);

  function tabInfo(id) {
    const c = ctx.conns.get(id);
    if (c) {
      const s = allowedSessions().find((x) => x.id === c.sessionId);
      if (!s) return null;
      return { tab: id, tipo: 'ssh', nombre: s.name, destino: `${s.username}@${s.host}:${s.port}`, conectada: !!c.stream };
    }
    const p = ctx.locals.get(id);
    if (p && ctx.settings().allowLocal) {
      return { tab: id, tipo: 'local', nombre: p.shell?.name || 'Consola local', destino: 'este equipo', conectada: true };
    }
    return null;
  }

  function getTab(id, { ssh = false } = {}) {
    const t = typeof id === 'string' ? tabInfo(id) : null;
    if (!t) throw new Error('Esa pestaña no existe o no está habilitada para agentes. Usa list_tabs.');
    if (!t.conectada) throw new Error('La pestaña no está conectada.');
    if (ssh && t.tipo !== 'ssh') throw new Error('Esta herramienta solo funciona en pestañas SSH.');
    return t;
  }

  // ---------- Aprobación del usuario ----------

  function grantAll(connId) {
    Object.assign(perm(connId), { read: true, all: true });
    ctx.onPerm(connId, true);
  }

  // Pregunta dentro del agente (Codex, Claude, Cursor…). Devuelve null si el agente no la
  // mostró, para usar entonces el aviso de la app.
  async function askInAgent(elicit, message, detail, connId) {
    const client = call.getStore()?.client || '';
    let plainOnly = plainClients.has(client);
    const text = `Mi Terminal: ${message}\n\n${detail}`;
    const ask = async (properties) => {
      const t0 = Date.now();
      const r = await elicit(text, { type: 'object', properties, required: [] }, ctx.approvalMs);
      const ms = Date.now() - t0;
      ctx.log({ aprobacion: 'agente', solicitud: message, respuesta: r.action, ms, formulario: Object.keys(properties).length > 0 });
      return { r, ms };
    };
    const ALL = {
      permitir_todo: {
        type: 'boolean',
        title: 'Permitir todo en esta pestaña',
        description: 'No volver a preguntar en esta pestaña de Mi Terminal hasta que se cierre.',
        default: false,
      },
    };
    try {
      let { r, ms } = await ask(connId && !plainOnly ? ALL : {});
      // Una respuesta instantánea no la dio una persona: el agente contestó solo, sin mostrar
      // la pregunta. Vale para rechazos y, sobre todo, para aceptaciones: nunca cuenta como
      // aprobación y se pasa al aviso de la app.
      // Algunos agentes rechazan al instante los formularios con campos: se reintenta sin ellos.
      if (ms < HUMAN_MS && r.action !== 'accept' && connId && !plainOnly) {
        plainOnly = true;
        if (plainClients.size > 200) plainClients.clear();
        plainClients.add(client);
        ({ r, ms } = await ask({}));
      }
      if (ms < HUMAN_MS) return null;
      if (r.action !== 'accept') return false;
      if (connId && r.content?.permitir_todo === true) grantAll(connId);
      return true;
    } catch (err) {
      ctx.log({ aprobacion: 'agente', solicitud: message, respuesta: `sin respuesta (${err.code || err.message})` });
      return err.code === 'client' ? null : false;
    }
  }

  function approve(message, detail, connId) {
    const elicit = call.getStore()?.elicit;
    const run = async () => {
      if (connId && perm(connId).all) return true;
      if (ctx.autoApprove) return true;
      if (elicit && ctx.settings().approval !== 'app') {
        const answer = await askInAgent(elicit, message, detail, connId);
        if (answer !== null) return answer;
      }
      const win = ctx.win();
      if (!win || win.isDestroyed()) return false;
      if (win.isMinimized()) win.restore();
      win.flashFrame(true);
      const buttons = ['Rechazar', 'Permitir'];
      if (connId) buttons.push('Permitir todo en esta pestaña');
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), ctx.approvalMs);
      try {
        const r = await ctx.dialog.showMessageBox(win, {
          type: 'warning',
          title: 'Solicitud de un agente (MCP)',
          message,
          detail,
          buttons,
          defaultId: 0, // Enter o Esc por accidente = rechazar
          cancelId: 0,
          noLink: true,
          signal: abort.signal,
        });
        ctx.log({ aprobacion: 'app', solicitud: message, respuesta: ['rechazar', 'permitir', 'permitir todo'][r.response] });
        if (connId && r.response === 2) grantAll(connId);
        return r.response > 0;
      } finally {
        clearTimeout(timer);
        if (!win.isDestroyed()) win.flashFrame(false);
      }
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  async function must(message, detail, connId) {
    if (await approve(message, detail, connId)) return;
    const inAgent = call.getStore()?.elicit && ctx.settings().approval !== 'app';
    throw new Error(REJECTED + (inAgent ? REJECTED_HINT : ''));
  }

  // ---------- Salida de una pestaña ----------

  const PROMPT = /[$#>%]\s*$/;

  // Espera a que el comando termine: la consola deja de escribir y vuelve a mostrar su indicador.
  async function waitQuiet(id, mark, timeoutMs) {
    const start = Date.now();
    for (;;) {
      await sleep(400);
      if (!tabInfo(id)?.conectada) return { text: '', state: 'La pestaña se cerró o se desconectó.' };
      const now = Date.now();
      const idle = now - Math.max(ctx.lastData(id), start);
      if (idle >= 1200) {
        const { text } = await ctx.renderer('read', { connId: id, mark, keep: true });
        const last = text.trimEnd().split('\n').pop() || '';
        if (PROMPT.test(last)) return { text, state: 'Terminó: la consola espera el siguiente comando.' };
        if (idle >= 6000) {
          return { text, state: 'Sin salida nueva hace unos segundos: puede seguir en ejecución o esperar una respuesta. Revisa con read_tab.' };
        }
      }
      if (now - start > timeoutMs) {
        const { text } = await ctx.renderer('read', { connId: id, mark, keep: true });
        return { text, state: 'Se agotó el tiempo de espera y el comando sigue en ejecución. Revisa con read_tab.' };
      }
    }
  }

  // ---------- Herramientas ----------

  const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const TAB = { type: 'string', description: 'Identificador de la pestaña (de list_tabs u open_session).' };

  const tools = [
    {
      name: 'list_sessions',
      description: 'Lista las sesiones SSH guardadas que el usuario habilitó para agentes. No incluye contraseñas ni claves.',
      inputSchema: obj({}),
      run: () => {
        const all = ctx.loadSessions();
        const list = all.filter((s) => s.allowAgents);
        return {
          sesiones: list.map((s) => ({ id: s.id, nombre: s.name, carpeta: s.folder, host: s.host, puerto: s.port, usuario: s.username, autenticacion: s.authType })),
          nota: `${all.length - list.length} sesiones más no están habilitadas para agentes. El usuario las habilita editando la sesión.`,
        };
      },
    },
    {
      name: 'list_consoles',
      description: 'Lista las consolas locales del equipo del usuario (PowerShell, CMD, WSL…) que se pueden abrir con open_console.',
      inputSchema: obj({}),
      run: async () => {
        if (!ctx.settings().allowLocal) return { consolas: [], nota: 'El usuario no habilitó las consolas locales para agentes.' };
        return { consolas: (await ctx.listShells()).map(({ id, name }) => ({ id, nombre: name })) };
      },
    },
    {
      name: 'list_tabs',
      description: 'Lista las pestañas abiertas en Mi Terminal que el agente puede usar.',
      inputSchema: obj({}),
      run: () => ({
        pestañas: [...ctx.conns.keys(), ...ctx.locals.keys()]
          .map(tabInfo)
          .filter(Boolean)
          .map((t) => ({ ...t, permiso: perm(t.tab).all ? 'todo permitido' : 'cada acción pide aprobación' })),
      }),
    },
    {
      name: 'open_session',
      description: 'Abre una pestaña conectada a una sesión SSH guardada. El usuario debe aprobarlo y, si hace falta, escribe la contraseña en la app.',
      inputSchema: obj({ session_id: { type: 'string', description: 'id de list_sessions' } }, ['session_id']),
      run: async ({ session_id }) => {
        const s = allowedSessions().find((x) => x.id === session_id);
        if (!s) throw new Error('Sesión no encontrada o no habilitada para agentes. Usa list_sessions.');
        await must(`Un agente quiere conectarse a "${s.name}"`, `${s.username}@${s.host}:${s.port}`);
        const r = await ctx.renderer('open', { sessionId: s.id }, 5 * 60000);
        if (!r.ok) throw new Error(r.error || 'No se pudo conectar.');
        perm(r.connId).read = true;
        return { tab: r.connId, nombre: s.name, estado: 'conectada' };
      },
    },
    {
      name: 'open_console',
      description: 'Abre una consola local del equipo del usuario en una pestaña nueva.',
      inputSchema: obj({ console_id: { type: 'string', description: 'id de list_consoles' } }, ['console_id']),
      run: async ({ console_id }) => {
        if (!ctx.settings().allowLocal) throw new Error('El usuario no habilitó las consolas locales para agentes.');
        const sh = (await ctx.listShells()).find((x) => x.id === console_id);
        if (!sh) throw new Error('Consola no disponible. Usa list_consoles.');
        await must(`Un agente quiere abrir una consola local: ${sh.name}`, 'Los comandos que ejecute ahí corren en este equipo, con tu usuario.');
        const r = await ctx.renderer('open', { shell: { id: sh.id, name: sh.name } }, 60000);
        if (!r.ok) throw new Error(r.error || 'No se pudo abrir la consola.');
        perm(r.connId).read = true;
        return { tab: r.connId, nombre: sh.name, estado: 'abierta' };
      },
    },
    {
      name: 'read_tab',
      description: 'Devuelve el texto que se ve en una pestaña (las últimas líneas).',
      inputSchema: obj({ tab: TAB, lines: { type: 'integer', description: 'Cuántas líneas (por defecto 200, máximo 2000).' } }, ['tab']),
      run: async ({ tab, lines }) => {
        const t = getTab(tab);
        const p = perm(tab);
        if (!p.read && !p.all) {
          await must(`Un agente quiere leer la pestaña "${t.nombre}"`, 'Podrá leer lo que se muestra en esta pestaña mientras siga abierta.', tab);
          p.read = true;
        }
        const n = Math.min(Math.max(Number.isInteger(lines) ? lines : 200, 1), 2000);
        const { text } = await ctx.renderer('read', { connId: tab, lines: n });
        return tail(text) || '(pestaña vacía)';
      },
    },
    {
      name: 'run_command',
      description:
        'Escribe un comando en una pestaña, pulsa Enter y devuelve la salida. El usuario lo ve en pantalla y debe aprobarlo. ' +
        'Para programas interactivos o que no terminan, usa después read_tab y send_keys.',
      inputSchema: obj(
        {
          tab: TAB,
          command: { type: 'string', description: `Comando a ejecutar (máximo ${MAX_CMD} caracteres).` },
          timeout_seconds: { type: 'integer', description: 'Espera máxima (por defecto 60, máximo 600).' },
        },
        ['tab', 'command']
      ),
      run: async ({ tab, command, timeout_seconds }) => {
        const t = getTab(tab);
        const cmd = str(command, 'command', MAX_CMD).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
        if (/[\x00-\x08\x0b-\x1f\x7f]/.test(cmd)) throw new Error('El comando contiene caracteres de control. Para teclas especiales usa send_keys.');
        if (busy.has(tab)) throw new Error('Ya hay un comando del agente en curso en esta pestaña.');
        busy.add(tab);
        try {
          await must(`Un agente quiere ejecutar un comando en "${t.nombre}" (${t.destino})`, cmd, tab);
          getTab(tab); // pudo cerrarse mientras se esperaba la aprobación
          perm(tab).read = true;
          const { mark } = await ctx.renderer('mark', { connId: tab });
          ctx.write(tab, `${cmd.replace(/\n/g, '\r')}\r`);
          const secs = Math.min(Math.max(Number.isInteger(timeout_seconds) ? timeout_seconds : 60, 1), 600);
          const { text, state } = await waitQuiet(tab, mark, secs * 1000);
          ctx.renderer('unmark', { connId: tab, mark }).catch(() => {});
          return `${tail(text)}\n\n[${state}]`;
        } finally {
          busy.delete(tab);
        }
      },
    },
    {
      name: 'send_keys',
      description:
        'Envía teclas o un texto corto a una pestaña sin pulsar Enter automáticamente: sirve para responder preguntas, ' +
        `salir de un programa o interrumpirlo. Teclas: ${Object.keys(KEYS).join(', ')}.`,
      inputSchema: obj(
        {
          tab: TAB,
          text: { type: 'string', description: 'Texto a escribir antes de las teclas (máximo 200 caracteres).' },
          keys: { type: 'array', items: { type: 'string', enum: Object.keys(KEYS) }, description: 'Teclas en orden.' },
        },
        ['tab']
      ),
      run: async ({ tab, text = '', keys = [] }) => {
        const t = getTab(tab);
        if (typeof text !== 'string' || text.length > 200 || /[\x00-\x1f\x7f]/.test(text)) throw new Error('"text" debe ser texto simple de hasta 200 caracteres.');
        if (!Array.isArray(keys) || keys.length > 20 || keys.some((k) => !Object.hasOwn(KEYS, k))) throw new Error('"keys" contiene teclas no admitidas.');
        if (!text && !keys.length) throw new Error('Indica "text" o "keys".');
        const detail = [text && `Texto: ${text}`, keys.length && `Teclas: ${keys.join(', ')}`].filter(Boolean).join('\n');
        await must(`Un agente quiere enviar teclas a "${t.nombre}" (${t.destino})`, detail, tab);
        getTab(tab);
        perm(tab).read = true;
        ctx.write(tab, text + keys.map((k) => KEYS[k]).join(''));
        await sleep(1000);
        const { text: out } = await ctx.renderer('read', { connId: tab, lines: 40 });
        return tail(out);
      },
    },
    {
      name: 'create_session',
      description: 'Crea una sesión SSH guardada (queda habilitada para agentes). No se pueden indicar contraseñas: la app se las pide al usuario al conectar.',
      inputSchema: obj(
        {
          name: { type: 'string' },
          host: { type: 'string' },
          username: { type: 'string' },
          port: { type: 'integer' },
          folder: { type: 'string', description: 'Carpeta para agruparla (opcional).' },
          auth: { type: 'string', enum: ['password', 'key', 'agent'], description: 'Por defecto "key".' },
          key_path: { type: 'string', description: 'Ruta en el equipo del usuario a la clave privada (si auth es "key").' },
        },
        ['name', 'host', 'username']
      ),
      run: async (a) => {
        const name = str(a.name, 'name', 80).trim();
        const host = str(a.host, 'host', 255).trim();
        const username = str(a.username, 'username', 64).trim();
        if (!/^[A-Za-z0-9._:-]+$/.test(host)) throw new Error('"host" no es un nombre o IP válido.');
        if (!/^[A-Za-z0-9._@-]+$/.test(username)) throw new Error('"username" no es válido.');
        const port = a.port === undefined ? 22 : a.port;
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('"port" no es válido.');
        const authType = a.auth === undefined ? 'key' : a.auth;
        if (!['password', 'key', 'agent'].includes(authType)) throw new Error('"auth" no es válido.');
        const folder = a.folder === undefined ? '' : str(a.folder, 'folder', 80).trim();
        const keyPath = authType === 'key' && a.key_path !== undefined ? str(a.key_path, 'key_path', 400).trim() : '';
        const authText = { password: 'contraseña', key: `clave privada${keyPath ? ` (${keyPath})` : ''}`, agent: 'agente SSH' }[authType];
        await must(
          `Un agente quiere crear la sesión "${name}"`,
          `${username}@${host}:${port}\nAutenticación: ${authText}${folder ? `\nCarpeta: ${folder}` : ''}\n\nQuedará habilitada para agentes.`
        );
        const s = ctx.saveSession({ name, folder, host, port, username, authType, keyPath, tunnels: [], allowAgents: true });
        ctx.sessionsChanged();
        return { id: s.id, nombre: s.name, nota: 'Sesión creada. Ábrela con open_session.' };
      },
    },
    {
      name: 'sftp_list',
      description: 'Lista una carpeta del servidor de una pestaña SSH.',
      inputSchema: obj({ tab: TAB, path: { type: 'string', description: 'Carpeta (por defecto, la carpeta personal).' } }, ['tab']),
      run: async ({ tab, path: dir }) => {
        const t = getTab(tab, { ssh: true });
        const target = dir === undefined ? '.' : str(dir, 'path');
        await must(`Un agente quiere listar una carpeta en "${t.nombre}"`, target, tab);
        const sftp = await ctx.getSftp(tab);
        const real = await ctx.promisify((cb) => sftp.realpath(target, cb));
        const items = await ctx.promisify((cb) => sftp.readdir(real, cb));
        return {
          carpeta: real,
          elementos: items
            .map((i) => ({ nombre: i.filename, tipo: i.attrs.isDirectory() ? 'carpeta' : i.attrs.isSymbolicLink() ? 'enlace' : 'archivo', bytes: i.attrs.size }))
            .sort((x, y) => x.nombre.localeCompare(y.nombre)),
        };
      },
    },
    {
      name: 'sftp_read',
      description: `Lee un archivo de texto del servidor (máximo ${MAX_FILE / 1024} KB).`,
      inputSchema: obj({ tab: TAB, path: { type: 'string' } }, ['tab', 'path']),
      run: async ({ tab, path: file }) => {
        const t = getTab(tab, { ssh: true });
        str(file, 'path');
        await must(`Un agente quiere leer un archivo en "${t.nombre}"`, file, tab);
        const sftp = await ctx.getSftp(tab);
        const st = await ctx.promisify((cb) => sftp.stat(file, cb));
        if (st.isDirectory()) throw new Error('Es una carpeta. Usa sftp_list.');
        if (st.size > MAX_FILE) throw new Error(`El archivo pesa ${st.size} bytes: es demasiado grande. Usa sftp_download.`);
        const buf = await ctx.promisify((cb) => sftp.readFile(file, cb));
        if (buf.includes(0)) throw new Error('El archivo es binario. Usa sftp_download.');
        return buf.toString('utf8');
      },
    },
    {
      name: 'sftp_write',
      description: `Crea o reemplaza un archivo de texto en el servidor (máximo ${MAX_FILE / 1024} KB).`,
      inputSchema: obj({ tab: TAB, path: { type: 'string' }, content: { type: 'string' } }, ['tab', 'path', 'content']),
      run: async ({ tab, path: file, content }) => {
        const t = getTab(tab, { ssh: true });
        str(file, 'path');
        if (typeof content !== 'string') throw new Error('Falta "content".');
        const bytes = Buffer.byteLength(content);
        if (bytes > MAX_FILE) throw new Error('El contenido es demasiado grande. Usa sftp_upload.');
        const sftp = await ctx.getSftp(tab);
        const exists = await ctx.promisify((cb) => sftp.stat(file, cb)).catch(() => null);
        if (exists?.isDirectory()) throw new Error('Esa ruta es una carpeta.');
        const preview = content.length > 1200 ? `${content.slice(0, 1200)}\n… (continúa)` : content;
        await must(
          `Un agente quiere ${exists ? 'REEMPLAZAR' : 'crear'} un archivo en "${t.nombre}"`,
          `${file}\n${bytes} bytes\n\nContenido:\n${preview}`,
          tab
        );
        const tmp = path.join(os.tmpdir(), `mi-terminal-agent-${crypto.randomBytes(8).toString('hex')}`);
        fs.writeFileSync(tmp, content);
        try {
          await ctx.putFile(tab, tmp, file, path.posix.basename(file));
        } finally {
          fs.rmSync(tmp, { force: true });
        }
        return `Archivo guardado: ${file} (${bytes} bytes).`;
      },
    },
    {
      name: 'sftp_upload',
      description: 'Sube un archivo del equipo del usuario al servidor.',
      inputSchema: obj(
        { tab: TAB, local_path: { type: 'string', description: 'Ruta absoluta en el equipo del usuario.' }, remote_path: { type: 'string', description: 'Ruta completa de destino en el servidor.' } },
        ['tab', 'local_path', 'remote_path']
      ),
      run: async ({ tab, local_path, remote_path }) => {
        const t = getTab(tab, { ssh: true });
        const local = path.resolve(str(local_path, 'local_path'));
        str(remote_path, 'remote_path');
        if (!path.isAbsolute(local_path)) throw new Error('"local_path" debe ser una ruta absoluta.');
        const st = fs.statSync(local, { throwIfNoEntry: false });
        if (!st?.isFile()) throw new Error('El archivo local no existe.');
        await must(`Un agente quiere subir un archivo a "${t.nombre}"`, `Desde este equipo: ${local}\nAl servidor: ${remote_path}\n${st.size} bytes`, tab);
        await ctx.putFile(tab, local, remote_path, path.basename(local));
        return `Archivo subido: ${remote_path} (${st.size} bytes).`;
      },
    },
    {
      name: 'sftp_download',
      description: 'Descarga un archivo del servidor al equipo del usuario. No reemplaza archivos existentes ni descarga tipos ejecutables.',
      inputSchema: obj(
        { tab: TAB, remote_path: { type: 'string' }, local_path: { type: 'string', description: 'Ruta absoluta de destino en el equipo del usuario.' } },
        ['tab', 'remote_path', 'local_path']
      ),
      run: async ({ tab, remote_path, local_path }) => {
        const t = getTab(tab, { ssh: true });
        str(remote_path, 'remote_path');
        if (!path.isAbsolute(str(local_path, 'local_path'))) throw new Error('"local_path" debe ser una ruta absoluta.');
        const local = path.resolve(local_path);
        if (ctx.isRunnable(path.basename(local))) throw new Error('No se descargan archivos de tipo ejecutable o sin extensión.');
        if (fs.existsSync(local)) throw new Error('Ya existe un archivo con ese nombre en el equipo. Elige otro.');
        if (!fs.statSync(path.dirname(local), { throwIfNoEntry: false })?.isDirectory()) throw new Error('La carpeta de destino no existe.');
        await must(`Un agente quiere descargar un archivo desde "${t.nombre}"`, `Del servidor: ${remote_path}\nA este equipo: ${local}`, tab);
        const sftp = await ctx.getSftp(tab);
        await ctx.promisify((cb) => sftp.fastGet(remote_path, local, cb));
        return `Archivo descargado: ${local}`;
      },
    },
  ];

  // Registro de lo que pidió cada agente (sin contenidos de archivos).
  const brief = (args) =>
    Object.fromEntries(
      Object.entries(args || {}).map(([k, v]) => [k, k === 'content' ? `(${String(v).length} caracteres)` : typeof v === 'string' ? v.slice(0, 300) : v])
    );
  const logged = tools.map((t) => ({
    ...t,
    run: async (args, extra) => {
      try {
        const out = await call.run(extra || {}, () => t.run(args));
        ctx.log({ herramienta: t.name, datos: brief(args), resultado: 'ok' });
        return out;
      } catch (err) {
        ctx.log({ herramienta: t.name, datos: brief(args), resultado: `error: ${err.message}` });
        throw err;
      }
    },
  }));

  return {
    tools: logged,
    // Al cerrarse o desconectarse una pestaña se pierden sus permisos.
    forget: (id) => {
      const had = perms.get(id)?.all;
      perms.delete(id);
      if (had) ctx.onPerm(id, false);
    },
    // El usuario da permiso total desde la propia app (menú de la pestaña).
    grant: (id) => {
      if (!tabInfo(id)) return false;
      grantAll(id);
      return true;
    },
    revoke: (id) => {
      if (perms.has(id)) Object.assign(perms.get(id), { read: false, all: false });
      ctx.onPerm(id, false);
    },
  };
};
