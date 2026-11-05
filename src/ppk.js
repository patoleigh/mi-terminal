// Convierte claves PuTTY (.ppk v2 y v3) al formato OpenSSH que entiende ssh2.
// Formato: https://the.earth.li/~sgtatham/putty/0.80/htmldoc/AppendixC.html
const crypto = require('crypto');

class PpkError extends Error {}

function parseFile(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const fields = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([\w-]+): (.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'Public-Lines' || key === 'Private-Lines') {
      const n = Number(value);
      fields[key.replace('-Lines', '')] = Buffer.from(lines.slice(i + 1, i + 1 + n).join(''), 'base64');
      i += n;
    } else {
      fields[key] = value;
    }
  }
  return fields;
}

// Lee los campos "string" del formato SSH (uint32 de largo + bytes).
function readStrings(buf) {
  const out = [];
  let o = 0;
  while (o + 4 <= buf.length) {
    const len = buf.readUInt32BE(o);
    if (o + 4 + len > buf.length) break;
    out.push(buf.subarray(o + 4, o + 4 + len));
    o += 4 + len;
  }
  return out;
}

const sshString = (b) => {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
};

// Electron usa BoringSSL, que no trae Argon2; se usa hash-wasm (WebAssembly).
async function argon2(kind, opts) {
  const fn = require('hash-wasm')[kind];
  if (!fn) throw new PpkError(`Derivación de clave no soportada: ${kind}`);
  return Buffer.from(await fn({ ...opts, outputType: 'binary' }));
}

async function deriveKeys(f, passphrase) {
  const version = f.version;
  if (version === 3) {
    const out = await argon2(String(f['Key-Derivation']).toLowerCase(), {
      password: Buffer.from(passphrase, 'utf8'),
      salt: Buffer.from(f['Argon2-Salt'], 'hex'),
      memorySize: Number(f['Argon2-Memory']),
      iterations: Number(f['Argon2-Passes']),
      parallelism: Number(f['Argon2-Parallelism']),
      hashLength: 80,
    });
    return { key: out.subarray(0, 32), iv: out.subarray(32, 48), macKey: out.subarray(48, 80) };
  }
  // Versión 2: SHA-1 encadenado para la clave, IV en cero, MAC con SHA-1.
  const h = (seq) => crypto.createHash('sha1').update(Buffer.from([0, 0, 0, seq])).update(passphrase).digest();
  return {
    key: Buffer.concat([h(0), h(1)]).subarray(0, 32),
    iv: Buffer.alloc(16),
    macKey: crypto.createHash('sha1').update('putty-private-key-file-mac-key').update(passphrase).digest(),
  };
}

// Arma la clave privada en formato OpenSSH ("openssh-key-v1", sin cifrar, solo en memoria).
function toOpenSsh(algorithm, pub, priv, comment) {
  const p = readStrings(pub);
  const s = readStrings(priv);
  let fields;
  if (algorithm === 'ssh-rsa') {
    const [, e, n] = p;
    const [d, pp, q, iqmp] = s;
    fields = [n, e, d, iqmp, pp, q];
  } else if (algorithm === 'ssh-ed25519') {
    const [, pk] = p;
    const [seed] = s;
    fields = [pk, Buffer.concat([seed, pk])];
  } else if (algorithm.startsWith('ecdsa-sha2-')) {
    const [, curve, q] = p;
    const [d] = s;
    fields = [curve, q, d];
  } else {
    throw new PpkError(`Tipo de clave PuTTY no soportado: ${algorithm}`);
  }

  const check = crypto.randomBytes(4);
  let section = Buffer.concat([check, check, sshString(algorithm), ...fields.map(sshString), sshString(comment)]);
  const pad = (8 - (section.length % 8)) % 8;
  section = Buffer.concat([section, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);

  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    Buffer.from([0, 0, 0, 1]),
    sshString(pub),
    sshString(section),
  ]);
  const b64 = body.toString('base64').match(/.{1,70}/g).join('\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function isPpk(text) {
  return /^PuTTY-User-Key-File-[23]:/.test(text);
}

function isPpkEncrypted(text) {
  return /^Encryption: (?!none)/m.test(text);
}

// Devuelve la clave en formato OpenSSH. Lanza PpkError si falta o falla la frase de paso.
async function convertPpk(text, passphrase = '') {
  const header = text.match(/^PuTTY-User-Key-File-([23]): (.+)$/m);
  if (!header) throw new PpkError('No es un archivo .ppk de PuTTY');
  const f = parseFile(text);
  f.version = Number(header[1]);
  const algorithm = header[2].trim();
  const encryption = f.Encryption;
  const comment = f.Comment || '';

  let priv = f.Private;
  let macKey;
  if (encryption === 'none') {
    macKey = f.version === 3 ? Buffer.alloc(0) : crypto.createHash('sha1').update('putty-private-key-file-mac-key').digest();
  } else if (encryption === 'aes256-cbc') {
    if (!passphrase) throw new PpkError('La clave está protegida: falta la frase de paso');
    const k = await deriveKeys(f, passphrase);
    const d = crypto.createDecipheriv('aes-256-cbc', k.key, k.iv);
    d.setAutoPadding(false);
    priv = Buffer.concat([d.update(priv), d.final()]);
    macKey = k.macKey;
  } else {
    throw new PpkError(`Cifrado de clave no soportado: ${encryption}`);
  }

  const macData = Buffer.concat([
    sshString(algorithm),
    sshString(encryption),
    sshString(comment),
    sshString(f.Public),
    sshString(priv),
  ]);
  const mac = crypto.createHmac(f.version === 3 ? 'sha256' : 'sha1', macKey).update(macData).digest('hex');
  if (mac !== String(f['Private-MAC']).toLowerCase()) {
    throw new PpkError(encryption === 'none' ? 'El archivo .ppk está dañado' : 'Frase de paso incorrecta');
  }

  return toOpenSsh(algorithm, f.Public, priv, comment);
}

module.exports = { convertPpk, isPpk, isPpkEncrypted, PpkError };
