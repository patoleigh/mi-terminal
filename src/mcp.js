// Servidor MCP local para agentes (Cursor, Codex, Claude…).
// Transporte "Streamable HTTP" con respuestas JSON. Escucha solo en 127.0.0.1 y exige un token.
const http = require('http');
const crypto = require('crypto');

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 6 * 1024 * 1024;

const digest = (x) => crypto.createHash('sha256').update(String(x)).digest();
const sameToken = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Solicitud demasiado grande'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// tools: [{ name, description, inputSchema, run(args) }]. getToken() devuelve el token vigente.
function startMcpServer({ port, getToken, info, tools }) {
  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const pending = new Map(); // preguntas enviadas al cliente que esperan respuesta

  // Pregunta al usuario dentro del propio agente ("elicitation"). La petición viaja por la
  // respuesta en curso (SSE) y el cliente contesta con otro POST.
  function elicitVia(res, sse) {
    return (message, requestedSchema, timeoutMs) =>
      new Promise((resolve, reject) => {
        const id = `mt-${crypto.randomUUID()}`;
        const fail = (code, text) => Object.assign(new Error(text), { code });
        const finish = (fn, value) => {
          clearTimeout(timer);
          pending.delete(id);
          res.off('close', onClose);
          fn(value);
        };
        const onClose = () => finish(reject, fail('closed', 'El agente cerró la conexión.'));
        const timer = setTimeout(() => {
          sse({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Sin respuesta a tiempo' } });
          finish(reject, fail('timeout', 'Sin respuesta a tiempo.'));
        }, timeoutMs);
        res.on('close', onClose);
        pending.set(id, (m) => (m.error ? finish(reject, fail('client', m.error.message || 'El agente no pudo preguntar.')) : finish(resolve, m.result || {})));
        sse({ jsonrpc: '2.0', id, method: 'elicitation/create', params: { message, requestedSchema } });
      });
  }

  async function rpc(msg, extra = {}) {
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return null;
    const { id, method, params = {} } = msg;
    const isNotification = id === undefined || id === null;
    const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });

    if (method === 'initialize') {
      return ok({
        protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: info,
        instructions:
          'Controla la app Mi Terminal del usuario. Solo ves las sesiones y pestañas que el usuario habilitó. ' +
          'Cada acción puede requerir que el usuario la apruebe en la app; si la rechaza, no insistas.',
      });
    }
    if (method === 'ping') return ok({});
    if (method === 'tools/list') {
      return ok({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    }
    if (method === 'tools/call') {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return isNotification ? null : rpcError(id, -32602, `Herramienta desconocida: ${params.name}`);
      try {
        const out = await tool.run(params.arguments && typeof params.arguments === 'object' ? params.arguments : {}, extra);
        const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
        return ok({ content: [{ type: 'text', text }] });
      } catch (err) {
        return ok({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    }
    if (isNotification) return null; // notifications/initialized, cancelaciones, etc.
    return rpcError(id, -32601, `Método no soportado: ${method}`);
  }

  const server = http.createServer(async (req, res) => {
    const reply = (status, body, headers = {}) => {
      const data = body === undefined ? '' : JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
      res.end(data);
    };
    try {
      // Una página web abierta en el navegador no debe poder hablar con este servidor:
      // los navegadores envían "Origin" y, con DNS rebinding, un "Host" distinto.
      const host = String(req.headers.host || '').toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return reply(403, { error: 'Host no permitido' });
      if (req.headers.origin) return reply(403, { error: 'Origen no permitido' });
      if ((req.url || '').split('?')[0] !== '/mcp') return reply(404, { error: 'No encontrado' });

      const auth = String(req.headers.authorization || '');
      const token = getToken();
      if (!token || !auth.startsWith('Bearer ') || !sameToken(auth.slice(7).trim(), token)) {
        return reply(401, { error: 'Token inválido o ausente' });
      }
      if (req.method !== 'POST') return reply(405, { error: 'Solo se admite POST' }, { Allow: 'POST' });

      let msg;
      try {
        msg = JSON.parse(await readBody(req));
      } catch {
        return reply(400, rpcError(null, -32700, 'JSON inválido'));
      }
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map(rpc))).filter(Boolean);
        return out.length ? reply(200, out) : reply(202);
      }
      // Respuesta del cliente a una pregunta nuestra.
      if (msg && typeof msg === 'object' && !msg.method && msg.id !== undefined && ('result' in msg || 'error' in msg)) {
        pending.get(String(msg.id))?.(msg);
        return reply(202);
      }

      // El identificador de sesión recuerda si el cliente sabe mostrar preguntas al usuario.
      let headers = {};
      if (msg?.method === 'initialize') {
        const canAsk = !!msg.params?.capabilities?.elicitation;
        headers = { 'Mcp-Session-Id': `mt1${canAsk ? 'e' : 'n'}-${crypto.randomUUID()}` };
      }

      let streaming = false;
      let ping;
      const sse = (obj) => {
        if (res.writableEnded) return;
        if (!streaming) {
          streaming = true;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          ping = setInterval(() => res.write(': espera\n\n'), 15000);
        }
        res.write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);
      };
      const canElicit =
        msg?.method === 'tools/call' &&
        String(req.headers['mcp-session-id'] || '').startsWith('mt1e-') &&
        String(req.headers.accept || '').includes('text/event-stream');

      const client = String(req.headers['mcp-session-id'] || '').slice(0, 80);
      const out = await rpc(msg, { client, elicit: canElicit ? elicitVia(res, sse) : null });
      if (streaming) {
        clearInterval(ping);
        if (out) sse(out);
        return res.end();
      }
      return out ? reply(200, out, headers) : reply(202, undefined, headers);
    } catch (err) {
      if (!res.headersSent) reply(500, rpcError(null, -32603, err.message));
    }
  });

  // Las llamadas esperan la aprobación del usuario y la salida del comando: sin límite corto.
  server.requestTimeout = 0;
  server.headersTimeout = 15000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

module.exports = { startMcpServer };
