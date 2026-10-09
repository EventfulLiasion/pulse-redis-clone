'use strict';
/* Phase-2 verification: replication, pub/sub, AOF rewrite.
 * Spawns its own master+replica on PM/PR (env overrides). */
const net = require('net');
const path = require('path');
const fs = require('fs');
const { startServer, connect: hConnect, removeTempDir, tempDir } = require('./helpers');
const { encodeCommand } = require('../src/resp');

const PM = Number(process.env.PULSE_PM_PORT || 16411);
const PR = Number(process.env.PULSE_PR_PORT || 16412);
const DM = process.env.PULSE_PM_DIR || tempDir('tmpv_master');
const DR = process.env.PULSE_PR_DIR || tempDir('tmpv_replica');
let procs = [], servers = [], passed = 0, failed = 0;
let currentTest = '(setup)';

function parseOne(b, off) {
  if (!b.length) return null;
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
const conn = (port) => hConnect(port);
function convo(sock, list, timeout = 3000) {
  const what = currentTest;
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0); const out = [];
    const timer = setTimeout(() => reject(new Error(`[${what}] timeout waiting for ${list.length} replies, got ${out.length}`)), timeout);
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
async function check(name, fn) {
  currentTest = name;
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.log('  FAIL - ' + name + ': ' + e.message); }
}
/** Poll until fn() returns a value deep-equal to want (replication lag-tolerant). */
async function pollEqual(fn, want, { timeout = 5000 } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    last = await fn();
    if (JSON.stringify(last) === JSON.stringify(want)) return last;
    if (Date.now() - t0 > timeout) throw new Error(`replication did not converge within ${timeout}ms: last=${JSON.stringify(last)} want=${JSON.stringify(want)}`);
    await new Promise(x => setTimeout(x, 100));
  }
}
/** Wait until the master reports >= n attached replicas (link established). */
async function waitSlaves(masterSock, n = 1, { timeout = 8000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const info = String(await one(masterSock, 'INFO', 'replication'));
    const m = /connected_slaves:(\d+)/.exec(info);
    if (m && Number(m[1]) >= n) return;
    if (Date.now() - t0 > timeout) throw new Error(`replica link not established within ${timeout}ms (info=${JSON.stringify(info)})`);
    await new Promise(x => setTimeout(x, 100));
  }
}
const eq = (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); };

async function main() {
  const master = startServer({ port: PM, dir: DM });
  const replica = startServer({ port: PR, dir: DR });
  servers = [master, replica];
  procs = [master.proc, replica.proc];
  for (const [h, port] of [[master, PM], [replica, PR]]) {
    try {
      await h.ready;
    } catch (e) {
      console.error(`server(:${port}) failed to start: ${e.message}`);
      console.error(`server state: ${h.describe()}`);
      process.exit(2);
    }
  }

  await check('replication: master writes land on replica incl. DB index', async () => {
    const m = await conn(PM), repl = await conn(PR);
    try {
      eq(await one(repl, 'REPLICAOF', '127.0.0.1', String(PM)), 'OK');
      // The clone has no replication backlog: writes issued before the replica
      // attaches are never delivered. Wait for link-up BEFORE writing.
      await waitSlaves(m, 1);
      await one(m, 'SELECT', '3');
      await one(m, 'SET', 'rk', 'rv');
      await one(m, 'SELECT', '0');
      await one(m, 'RPUSH', 'rl', 'a');
      // poll: replication is async, no fixed sleep
      await one(repl, 'SELECT', '3');
      await pollEqual(() => one(repl, 'GET', 'rk'), 'rv');
      await one(repl, 'SELECT', '0');
      await pollEqual(() => one(repl, 'LRANGE', 'rl', '0', '-1'), ['a']);
      eq(await one(repl, 'GET', 'rk'), null); // DB separation on replica too
    } finally { try { m.end(); } catch {} try { repl.end(); } catch {} }
  });

  await check('pub/sub subscribe->publish->message', async () => {
    const sub = await conn(PM), pub = await conn(PM);
    try {
      const gotP = convo(sub, [[ 'SUBSCRIBE', 'news' ]]);
      const [ack] = await gotP;
      eq(ack[0], 'subscribe');
      const msgP = new Promise((res, rej) => {
        let buf = Buffer.alloc(0);
        const t = setTimeout(() => rej(new Error(`[${currentTest}] no message within 2500ms`)), 2500);
        sub.on('data', (c) => {
          buf = Buffer.concat([buf, c]);
          const r = parseOne(buf, 0);
          if (r) { clearTimeout(t); res(r.value); }
        });
      });
      await new Promise(x => setTimeout(x, 150));
      eq(await one(pub, 'PUBLISH', 'news', 'hello'), 1);
      const msg = await msgP;
      eq(msg, ['message', 'news', 'hello']);
    } finally { try { sub.end(); } catch {} try { pub.end(); } catch {} }
  });

  await check('AOF rewrite roundtrip (geo+zset+stream+multiDB)', async () => {
    const s = await conn(PM);
    try {
      await one(s, 'FLUSHALL');
      await one(s, 'GEOADD', 'g', '10', '20', 'p1');
      await one(s, 'ZADD', 'z', '5', 'm');
      await one(s, 'XADD', 'st', '1-1', 'f', 'v');
      await one(s, 'XGROUP', 'CREATE', 'st', 'grp', '0-0');
      await one(s, 'SELECT', '2');
      await one(s, 'SET', 'k2', 'v2', 'PX', '60000');
      await one(s, 'SELECT', '0');
      await one(s, 'BGREWRITEAOF');
      // wait for the rewrite to land instead of a fixed sleep
      const t0 = Date.now();
      for (;;) {
        const aof = fs.readFileSync(require('path').join(DM, 'appendonly.aof'), 'utf8');
        if (/GEOADD/.test(aof)) break;
        if (Date.now() - t0 > 8000) throw new Error('BGREWRITEAOF did not finish within 8000ms');
        await new Promise(x => setTimeout(x, 100));
      }
    } finally { try { s.end(); } catch {} }
    // restart master on the same data dir
    servers[0].kill();
    await new Promise(x => setTimeout(x, 400)); // let the port close
    const m2 = startServer({ port: PM, dir: DM, keepData: true });
    servers[0] = m2; procs[0] = m2.proc;
    await m2.ready;
    const s2 = await conn(PM);
    try {
      eq(await one(s2, 'GEODIST', 'g', 'p1', 'p1'), '0.0000');
      eq(await one(s2, 'ZRANGE', 'z', '0', '-1'), ['m']);
      eq(await one(s2, 'XLEN', 'st'), 1);
      await one(s2, 'SELECT', '2');
      eq(await one(s2, 'GET', 'k2'), 'v2');
      const t = await one(s2, 'PTTL', 'k2');
      if (!(t > 1000)) throw new Error('ttl lost in rewrite: ' + t);
    } finally { try { s2.end(); } catch {} }
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  cleanup();
  process.exit(failed ? 1 : 0);
}
function cleanup() {
  procs.forEach(p => { try { p.kill(); } catch {} });
  for (const d of [DM, DR]) {
    try { removeTempDir(d); } catch (e) { console.error(`cleanup: ${e.message}`); }
  }
}
main().catch(e => {
  console.error('HARNESS FATAL' + (currentTest ? ` during/after [${currentTest}]` : '') + ': ' + ((e && e.stack) || e));
  for (const h of servers) { try { console.error(`server state: ${h.describe()}`); } catch {} }
  cleanup();
  process.exit(2);
});
