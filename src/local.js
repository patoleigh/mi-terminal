// Consolas locales de este equipo: CMD, PowerShell, Git Bash y distribuciones WSL.
// La interfaz solo elige un identificador de esta lista; nunca envía una ruta ni un comando.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const sysRoot = process.env.SystemRoot || 'C:/Windows';
const system32 = (...p) => path.join(sysRoot, 'System32', ...p);
const WSL = system32('wsl.exe');

const firstExisting = (paths) => paths.find((p) => p && fs.existsSync(p));

// wsl.exe escribe en UTF-16; se piden solo los nombres de las distribuciones.
function wslDistros() {
  if (!fs.existsSync(WSL)) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(WSL, ['--list', '--quiet'], { encoding: 'buffer', timeout: 4000, windowsHide: true }, (err, out) => {
      if (err || !out) return resolve([]);
      const names = out
        .toString('utf16le')
        .split(/\r?\n/)
        .map((l) => l.replace(/\0/g, '').trim())
        .filter((n) => /^[\w.\-]+$/.test(n) && !/^docker-desktop/.test(n));
      resolve(names);
    });
  });
}

async function listShells() {
  const pf = process.env.ProgramFiles;
  const shells = [
    { id: 'powershell', name: 'PowerShell', file: system32('WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] },
    { id: 'cmd', name: 'CMD', file: system32('cmd.exe'), args: [] },
  ];
  const pwsh = firstExisting([pf && path.join(pf, 'PowerShell', '7', 'pwsh.exe')]);
  if (pwsh) shells.unshift({ id: 'pwsh', name: 'PowerShell 7', file: pwsh, args: ['-NoLogo'] });

  const bash = firstExisting([
    pf && path.join(pf, 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ]);
  if (bash) shells.push({ id: 'gitbash', name: 'Git Bash', file: bash, args: ['--login', '-i'] });

  for (const d of await wslDistros()) {
    shells.push({ id: `wsl:${d}`, name: `${d} (WSL)`, file: WSL, args: ['-d', d, '--cd', '~'] });
  }
  return shells.filter((s) => fs.existsSync(s.file));
}

// Abre la consola elegida en una pseudo-terminal (ConPTY), en la carpeta del usuario.
async function openShell(shellId, cols, rows) {
  const shell = (await listShells()).find((s) => s.id === shellId);
  if (!shell) throw new Error('Esa consola no está disponible en este equipo.');
  const pty = require('node-pty');
  const size = (n, def) => (Number.isInteger(n) && n > 0 && n < 1000 ? n : def);
  return pty.spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cols: size(cols, 80),
    rows: size(rows, 24),
    cwd: os.homedir(),
    env: process.env,
  });
}

module.exports = { listShells, openShell };
