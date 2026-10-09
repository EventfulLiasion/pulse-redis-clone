'use strict';
/** Tiny interactive CLI: node src/cli.js [--port 6379] [--host 127.0.0.1] */
const net = require('net');
const readline = require('readline');
const { encodeCommand } = require('./resp');

const args = process.argv.slice(2);

function usage() {
  return 'usage: node src/cli.js [--host 127.0.0.1] [--port 6379]';
}

// Root cause of the old bug: args[args.indexOf('--host') + 1] evaluates to
// args[0] when --host is absent (indexOf returns -1), so e.g.
// `cli.js --port 6379` used host='--port'. Parse explicitly instead.
function parseArgs(argv) {
  let host = '127.0.0.1', port = 6379;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`missing value for --host\n${usage()}`);
      host = v;
    } else if (a === '--port') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`missing value for --port\n${usage()}`);
      if (!/^\d+$/.test(v)) throw new Error(`invalid port '${v}': must be an integer 1-65535\n${usage()}`);
      port = Number(v);
      if (port < 1 || port > 65535) throw new Error(`invalid port '${v}': must be an integer 1-65535\n${usage()}`);
    } else if (a === '--help' || a === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument '${a}'\n${usage()}`);
    }
  }
  return { host, port };
}

let host, port;
try {
  ({ host, port } = parseArgs(args));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

if (require.main === module) main();

function main() {

const sock = net.createConnection({ host, port }, () => {
  console.log(`connected to pulse-redis ${host}:${port} — type commands, EXIT to quit`);
  rl.prompt();
});

let buf = Buffer.alloc(0);
sock.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  // try to pretty-print complete replies (may be multiple)
  while (buf.length) {
    const r = tryFormat(buf);
    if (!r) break;
    console.log(r.text);
    buf = buf.slice(r.used);
    rl.prompt();
  }
});
sock.on('close', () => { console.log('disconnected'); process.exit(0); });
sock.on('error', (e) => { console.error('connection error:', e.message); process.exit(1); });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${host}:${port}> ` });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return rl.prompt();
  if (/^(exit|quit)$/i.test(t)) { sock.end(); rl.close(); return; }
  sock.write(encodeCommand(splitArgs(t)));
});
rl.on('close', () => sock.end());
} // end main()

module.exports = { parseArgs, splitArgs };

function splitArgs(line) {
  const out = []; let cur = '', q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && i + 1 < line.length) cur += line[++i]; else cur += c; }
    else if (c === '"' || c === "'") q = c;
    else if (c === ' ' || c === '\t') { if (cur) { out.push(cur); cur = ''; } }
    else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function tryFormat(b) {
  // minimal RESP pretty printer; returns {text, used} or null if incomplete
  const r = parseOne(b, 0);
  if (!r) return null;
  return { text: formatVal(r.value), used: r.next };
}
function parseOne(b, off) {
  if (off >= b.length) return null;
  const t = String.fromCharCode(b[off]);
  const eol = b.indexOf('\r\n', off);
  if (eol === -1) return null;
  const line = b.slice(off + 1, eol).toString();
  if (t === '+') return { value: line, next: eol + 2, str: line };
  if (t === '-') return { value: new Error(line), next: eol + 2 };
  if (t === ':') return { value: parseInt(line, 10), next: eol + 2 };
  if (t === '$') {
    const len = parseInt(line, 10);
    if (len === -1) return { value: null, next: eol + 2 };
    if (b.length < eol + 2 + len + 2) return null;
    return { value: b.slice(eol + 2, eol + 2 + len).toString(), next: eol + 2 + len + 2 };
  }
  if (t === '*') {
    const n = parseInt(line, 10);
    if (n === -1) return { value: null, next: eol + 2 };
    let cur = eol + 2; const arr = [];
    for (let i = 0; i < n; i++) { const r = parseOne(b, cur); if (!r) return null; arr.push(r.value); cur = r.next; }
    return { value: arr, next: cur };
  }
  return null;
}
function formatVal(v, depth = 0) {
  if (v instanceof Error) return `(error) ${v.message}`;
  if (v === null) return '(nil)';
  if (Array.isArray(v)) {
    if (!v.length) return '(empty array)';
    return v.map((x, i) => `${String(i + 1)}) ${Array.isArray(x) ? `[${x.map(formatVal).join(', ')}]` : x instanceof Error ? `(error) ${x.message}` : x === null ? '(nil)' : JSON.stringify(x)}`).join('\n');
  }
  return JSON.stringify(v);
}
