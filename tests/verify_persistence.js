'use strict';
// Targeted checks for the NEW persistence behaviors (torn tail, corrupt RDB, INFO health).
const net = require('net');
const fs = require('fs');
const path = require('path');
const { startServer, connect, removeTempDir, tempDir } = require('./helpers');
const { encodeCommand } = require('../src/resp');

function parseOne(b, off) {
  const t = String.fromCharCode(b[off]);
  const eol = b.indexOf('\r\n', off);
  if (eol === -1) return null;
  const line = b.slice(off + 1, eol).toString();
  if (t === '+') return { value: line, next: eol + 2 };
  if (t === '-') return { value: new Error(line), next: eol + 2 };
  if (t === ':') return { value: parseInt(line, 10), next: eol + 2 };
  if (t === '$') {
    const len = parseInt(line, 10);
    if (len === -1) return { value: null, next: eol + 2 };
    if (b.length < eol + 2 + len + 2) return null;
    return { value: b.slice(eol + 2, eol + 2 + len).toString('latin1'), next: eol + 2 + len + 2 };
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
function convo(sock, list, timeout = 3000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0); const out = [];
    const timer = setTimeout(() => reject(new Error('timeout')), timeout);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (out.length < list.length) { const r = parseOne(buf, 0); if (!r) break; buf = buf.slice(r.next); out.push(r.value); }
      if (out.length >= list.length) { clearTimeout(timer); sock.removeListener('data', onData); resolve(out); }
    };
    sock.on('data', onData);
    for (const argv of list) sock.write(encodeCommand(argv));
  });
}
const one = (s, ...a) => convo(s, [a]).then(r => r[0]);
const P_TORN = Number(process.env.PULSE_PERS_TORN_PORT || 17431);
const P_RDB = Number(process.env.PULSE_PERS_RDB_PORT || 17432);
const P_INFO = Number(process.env.PULSE_PERS_INFO_PORT || 17433);
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok - ' + name); }
  catch (e) { failed++; console.log('  FAIL - ' + name + ': ' + e.message); }
}

async function main() {
  // A: torn AOF tail -> complete prefix replays, torn tail truncated with warning
  await check('torn AOF tail recovers with warning', async () => {
    const dir = tempDir('tmptorn');
    fs.mkdirSync(dir, { recursive: true });
    const good = Buffer.concat([encodeCommand(['SET', 'k', 'v']), encodeCommand(['SET', 'k2', 'v2'])]);
    fs.writeFileSync(path.join(dir, 'appendonly.aof'), Buffer.concat([good, Buffer.from('*3\r\n$3\r\nSET\r\n$2\r\nx\r\n$5\r\nab')]));
    const srv = startServer({ port: P_TORN, dir, keepData: true });
    await srv.ready;
    const s = await connect(P_TORN);
    try {
      if (await one(s, 'GET', 'k') !== 'v') throw new Error('complete prefix did not replay');
      const log = srv.proc._errLog + srv.proc._outLog;
      if (!/damaged trailing/.test(log)) throw new Error('no damaged-tail warning logged; logs: ' + JSON.stringify(log.slice(-500)));
      const size = fs.statSync(path.join(dir, 'appendonly.aof')).size;
      if (size !== good.length) throw new Error(`torn tail not truncated (size ${size}, want ${good.length})`);
    } finally { s.end(); srv.kill(); }
    removeTempDir(dir);
  });

  // B: corrupt RDB -> starts empty, error visible
  await check('corrupt RDB starts empty with loud error', async () => {
    const dir = tempDir('tmpbadrdb');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'dump.rdb.json'), '{not json');
    const srv = startServer({ port: P_RDB, dir, keepData: true });
    await srv.ready;
    const s = await connect(P_RDB);
    try {
      if (await one(s, 'DBSIZE') !== 0) throw new Error('expected empty dataset');
      const log = srv.proc._errLog + srv.proc._outLog;
      if (!/RDB load/.test(log)) throw new Error('no RDB error logged');
    } finally { s.end(); srv.kill(); }
    removeTempDir(dir);
  });

  // C: INFO persistence exposes health fields
  await check('INFO persistence exposes write health', async () => {
    const dir = tempDir('tmpinfo');
    const srv = startServer({ port: P_INFO, dir });
    await srv.ready;
    const s = await connect(P_INFO);
    try {
      const info = String(await one(s, 'INFO', 'persistence'));
      for (const f of ['aof_write_errors', 'aof_last_write_status', 'aof_last_error']) {
        if (!info.includes(f)) throw new Error('missing field ' + f);
      }
    } finally { s.end(); srv.kill(); }
    removeTempDir(dir);
  });

  console.log(failed ? `\n${failed} FAILED` : '\nALL PERSISTENCE CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error('FATAL ' + ((e && e.stack) || e)); process.exit(2); });
