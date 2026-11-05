// Estadísticas del servidor (CPU, RAM, red, uptime, usuarios, discos).
// Se leen por un canal SSH aparte, sin terminal, con comandos de solo lectura.

const INTERVAL_SECONDS = 2;
const VIRTUAL_IF = /^(lo|docker|veth|br-|virbr|cni|flannel|cali|vxlan|kube)/;

// Cada bloque termina en "@@E". Funciona en Ubuntu x86_64 y ARM sin instalar nada.
const SCRIPT = `export LC_ALL=C
while :; do
  echo "@@H $(hostname)"
  head -n1 /proc/stat | sed 's/^/@@C /'
  grep -E '^(MemTotal|MemAvailable):' /proc/meminfo | sed 's/^/@@M /'
  awk 'NR>2 { gsub(":", " "); print "@@N", $1, $2, $10 }' /proc/net/dev
  echo "@@U $(cut -d' ' -f1 /proc/uptime)"
  echo "@@W $(who 2>/dev/null | awk '{print $1}' | sort | uniq -c | tr -s ' ' | tr '\\n' ',')"
  df -P -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null | awk 'NR>1 { print "@@D", $6, $5 }'
  echo "@@E"
  sleep ${INTERVAL_SECONDS}
done`;

// Convierte un bloque de texto en datos. "prev" es la muestra anterior, para calcular CPU y red.
function parseBlock(block, prev) {
  const out = { host: '', memTotal: 0, memUsed: 0, uptime: 0, users: [], disks: [], cpu: null, up: null, down: null };
  const raw = { t: Date.now(), cpu: null, rx: 0, tx: 0 };
  let memAvail = 0;

  for (const line of block.split('\n')) {
    const [tag, ...p] = line.trim().split(/\s+/);
    switch (tag) {
      case '@@H':
        out.host = p.join(' ');
        break;
      case '@@C': {
        // cpu user nice system idle iowait irq softirq steal
        const v = p.slice(1, 9).map(Number);
        raw.cpu = { idle: v[3] + (v[4] || 0), total: v.reduce((a, b) => a + b, 0) };
        break;
      }
      case '@@M':
        if (p[0] === 'MemTotal:') out.memTotal = Number(p[1]) * 1024;
        else if (p[0] === 'MemAvailable:') memAvail = Number(p[1]) * 1024;
        break;
      case '@@N':
        // Solo interfaces físicas: las virtuales (Docker, puentes, VPN internas) duplicarían el tráfico.
        if (p[0] && !VIRTUAL_IF.test(p[0])) {
          raw.rx += Number(p[1]) || 0;
          raw.tx += Number(p[2]) || 0;
        }
        break;
      case '@@U':
        out.uptime = Number(p[0]) || 0;
        break;
      case '@@W':
        out.users = p
          .join(' ')
          .split(',')
          .map((x) => x.trim().split(' '))
          .filter(([count, name]) => count && name)
          .map(([count, name]) => ({ name, count: Number(count) }));
        break;
      case '@@D':
        if (p[0]) out.disks.push({ mount: p[0], pct: parseInt(p[1], 10) || 0 });
        break;
    }
  }

  out.memUsed = Math.max(0, out.memTotal - memAvail);

  if (prev) {
    const dt = (raw.t - prev.t) / 1000;
    if (raw.cpu && prev.cpu) {
      const dTotal = raw.cpu.total - prev.cpu.total;
      const dIdle = raw.cpu.idle - prev.cpu.idle;
      if (dTotal > 0) out.cpu = Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100));
    }
    if (dt > 0) {
      // bits por segundo; si un contador se reinicia, se informa 0
      out.down = Math.max(0, ((raw.rx - prev.rx) * 8) / dt);
      out.up = Math.max(0, ((raw.tx - prev.tx) * 8) / dt);
    }
  }
  return { out, raw };
}

// Abre el canal y llama a onStats con cada muestra. Si el servidor no lo permite, no hace nada.
function startStats(client, onStats) {
  client.exec(SCRIPT, (err, stream) => {
    if (err) return;
    let buf = '';
    let prev = null;
    stream.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('@@E')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 3);
        const { out, raw } = parseBlock(block, prev);
        prev = raw;
        onStats(out);
      }
      if (buf.length > 65536) buf = '';
    });
    stream.stderr.on('data', () => {});
  });
}

module.exports = { startStats, parseBlock, SCRIPT };
