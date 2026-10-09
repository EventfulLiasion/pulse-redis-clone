'use strict';
/* Adversarial audit suite. Spawns its own server on PORT (env override).
 * Each test is independent (FLUSHALL/SELECT 0 where needed) and time-boxed.
 * Exit code 0 only if all pass. Prints FAIL lines for confirmed bugs. */
const net = require('net');
const path = require('path');
const fs = require('fs');
const { startServer, connect: hConnect, removeTempDir, tempDir } = require('./helpers');
const { encodeCommand, Parser } = require('../src/resp');

const PORT = Number(process.env.PULSE_ADV_PORT || 16380);
const DIR = process.env.PULSE_ADV_DIR || tempDir('tmpaudit');
let server, passed = 0, failed = 0;
const failures = [];
let currentTest = '(setup)';

function conn() { return hConnect(PORT); }

function raw(argv) { return encodeCommand(argv.map(String)); }
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
    return { value: b.slice(eol + 2, eol + 2 + len), next: eol + 2 + len + 2 };
  }
  if (t === '*') {
    const n = parseInt(line, 10);
    if (n === -1 || n === -1) return { value: null, next: eol + 2 };
    if (Number.isNaN(n) || n < 0) return { value: new Error('proto'), next: eol + 2 };
    let cur = eol + 2; const arr = [];
    for (let i = 0; i < n; i++) { const r = parseOne(b, cur); if (!r) return null; arr.push(r.value); cur = r.next; }
    return { value: arr, next: cur };
  }
  return null;
}
function norm(v) {
  if (v instanceof Error) return 'ERR:' + v.message;
  if (Buffer.isBuffer(v)) return v.toString('latin1');
  if (Array.isArray(v)) return v.map(norm);
  return v;
}
function conn() {
  return new Promise((res, rej) => {
    const s = net.createConnection({ port: PORT }, () => res(s));
    s.on('error', rej);
  });
}
// send argv list (pipelined), collect exactly n replies (or timeout naming the test)
function convo(sock, list, { timeout = 2000 } = {}) {
  const what = currentTest;
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const out = [];
    const timer = setTimeout(() => reject(new Error(`[${what}] timeout waiting for ${list.length} replies, got ${out.length}`)), timeout);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (out.length < list.length) {
        const r = parseOne(buf, 0);
        if (!r) break;
        buf = buf.slice(r.next);
        out.push(r.value);
      }
      if (out.length >= list.length) { clearTimeout(timer); sock.removeListener('data', onData); resolve(out); }
    };
    sock.on('data', onData);
    for (const argv of list) sock.write(Array.isArray(argv) ? raw(argv) : argv);
  });
}
const one = (sock, ...argv) => convo(sock, [[...argv]]).then(r => r[0]);
async function check(name, fn) {
  currentTest = name;
  const s = await hConnect(PORT);
  try {
    await one(s, 'FLUSHALL');
    await fn(s);
    passed++; console.log('  ok - ' + name);
  } catch (e) { failed++; failures.push(name); console.log('  FAIL - ' + name + ': ' + e.message); }
  finally { try { s.end(); } catch {} }
}
function eq(a, b, msg) {
  const x = JSON.stringify(norm(a)), y = JSON.stringify(norm(b));
  if (x !== y) throw new Error((msg || '') + ' expected ' + y + ' got ' + x);
}
function isErr(v, contains) {
  if (!(v instanceof Error)) throw new Error('expected error, got ' + JSON.stringify(norm(v)));
  if (contains && !v.message.includes(contains)) throw new Error('error missing "' + contains + '": ' + v.message);
}

/** Kill the server and start a fresh one on the same port/dir (persistence roundtrip). */
async function restartServer() {
  server.kill();
  await new Promise(r => setTimeout(r, 400)); // let the port close
  server = startServer({ port: PORT, dir: DIR, keepData: true });
  await server.ready;
}

async function main() {
  server = startServer({ port: PORT, dir: DIR });
  try {
    await server.ready;
  } catch (e) {
    console.error(`server failed to start: ${e.message}`);
    console.error(`server state: ${server.describe()}`);
    process.exit(2);
  }

  await check('binary roundtrip (NUL+0xFF bytes)', async (s) => {
    const val = Buffer.from([0x00, 0x41, 0xff, 0x00, 0xfe]);
    // send raw bytes manually (SET has 3 args -> *3)
    const cmd = Buffer.concat([Buffer.from('*3\r\n$3\r\nSET\r\n$2\r\nbk\r\n$5\r\n'), val, Buffer.from('\r\n')]);
    const [r1] = await convo(s, [cmd]);
    if (r1 instanceof Error) throw new Error('set failed: ' + r1.message);
    // GET raw length must be 5 bytes
    const s2 = await conn();
    const [r2] = await convo(s2, [raw(['GET', 'bk'])]);
    s2.end();
    if (!Buffer.isBuffer(r2) || r2.length !== 5 || !r2.equals(val)) throw new Error('binary mismatch: len=' + (r2 && r2.length) + ' hex=' + (r2 && r2.toString('hex')));
  });

  await check('error prefix not doubled (WRONGTYPE)', async (s) => {
    await one(s, 'RPUSH', 'lst', 'a');
    const r = await one(s, 'GET', 'lst');
    isErr(r, 'WRONGTYPE');
    if (String(r.message).startsWith('ERR WRONGTYPE') || String(r.message).startsWith('ERR ERR')) throw new Error('doubled prefix: ' + r.message);
  });

  await check('pipelining + partial frames', async (s) => {
    const s2 = await conn();
    s2.write(Buffer.from('*3\r\n$3\r\nSET\r\n$2\r\nk1\r\n$2\r\nv1\r\n*2\r\n$3\r\nGET\r\n'));
    await new Promise(r => setTimeout(r, 150));
    s2.write(Buffer.from('$2\r\nk1\r\n'));
    const got = await new Promise((res, rej) => {
      let buf = Buffer.alloc(0); const out = [];
      const t = setTimeout(() => rej(new Error('partial timeout, got ' + out.length)), 2000);
      s2.on('data', (c) => {
        buf = Buffer.concat([buf, c]);
        while (out.length < 2) { const r = parseOne(buf, 0); if (!r) break; buf = buf.slice(r.next); out.push(r.value); }
        if (out.length === 2) { clearTimeout(t); res(out); }
      });
    });
    eq(got[0], 'OK'); eq(got[1], 'v1');
    s2.end();
  });

  await check('malformed input does not desync/desync recovery', async (s) => {
    s.write(Buffer.from('*abc\r\n'));
    await new Promise(r => setTimeout(r, 200));
    const r = await one(s, 'PING');
    eq(r, 'PONG');
  });

  await check('SET KEEPTTL preserves TTL', async (s) => {
    await one(s, 'SET', 'k', 'v', 'EX', '100');
    await one(s, 'SET', 'k', 'v2', 'KEEPTTL');
    const t = await one(s, 'TTL', 'k');
    if (!(t > 50 && t <= 100)) throw new Error('ttl not kept: ' + t);
  });

  await check('SET trailing garbage errors', async (s) => {
    const r = await one(s, 'SET', 'k', 'v', 'EX');
    isErr(r, 'syntax');
  });

  await check('SETEX rejects bad expire', async (s) => {
    const r = await one(s, 'SETEX', 'k', 'notanint', 'v');
    isErr(r);
  });

  await check('COPY is independent (no aliasing)', async (s) => {
    await one(s, 'RPUSH', 'src', 'a', 'b');
    await one(s, 'COPY', 'src', 'dst');
    await one(s, 'RPUSH', 'dst', 'c');
    eq(await one(s, 'LRANGE', 'src', '0', '-1'), ['a', 'b']);
    eq(await one(s, 'LRANGE', 'dst', '0', '-1'), ['a', 'b', 'c']);
  });

  await check('RENAME same key is no-op', async (s) => {
    await one(s, 'SET', 'k', 'v');
    eq(await one(s, 'RENAME', 'k', 'k'), 'OK');
    eq(await one(s, 'GET', 'k'), 'v');
  });

  await check('DEL on expired key returns 0', async (s) => {
    await one(s, 'SET', 'k', 'v', 'PX', '1');
    await new Promise(r => setTimeout(r, 30));
    eq(await one(s, 'DEL', 'k'), 0);
  });

  await check('EXPIRE LT without TTL does not set', async (s) => {
    await one(s, 'SET', 'k', 'v');
    eq(await one(s, 'EXPIRE', 'k', '100', 'LT'), 0);
    eq(await one(s, 'TTL', 'k'), -1);
  });

  await check('PEXPIRE NaN rejected', async (s) => {
    await one(s, 'SET', 'k', 'v');
    const r = await one(s, 'PEXPIRE', 'k', 'abc');
    isErr(r);
  });

  await check('LPOP negative count errors', async (s) => {
    await one(s, 'RPUSH', 'l', 'a');
    const r = await one(s, 'LPOP', 'l', '-1');
    isErr(r);
  });

  await check('BLPOP timeout 0 blocks then wakes on push', async (s) => {
    const w = await conn();
    const p = convo(w, [raw(['BLPOP', 'blk', '0'])], { timeout: 3000 });
    await new Promise(r => setTimeout(r, 200));
    await one(s, 'RPUSH', 'blk', 'hello');
    const [r] = await p;
    eq(r, ['blk', 'hello']);
    w.end();
  });

  await check('RPUSHX on missing key is no-op (no wake, no create)', async (s) => {
    // empty-list keys do not exist, so RPUSHX on a missing key must not create it
    // (this matches real redis; the waiter below must time out with nil)
    eq(await one(s, 'RPUSHX', 'lx', 'woke'), 0);
    eq(await one(s, 'EXISTS', 'lx'), 0);
    const w = await conn();
    const [r] = await convo(w, [raw(['BLPOP', 'lx', '1'])], { timeout: 3000 });
    eq(r, null);
    w.end();
  });

  await check('ZADD wakes BZPOPMIN waiter', async (s) => {
    const w = await conn();
    const p = convo(w, [raw(['BZPOPMIN', 'bz', '2'])], { timeout: 3000 });
    await new Promise(r => setTimeout(r, 200));
    await one(s, 'ZADD', 'bz', '1.5', 'm');
    const [r] = await p;
    eq(r, ['bz', 'm', '1.5']);
    w.end();
  });

  await check('XREAD BLOCK ms timing (~200ms not 200s)', async (s) => {
    const t0 = Date.now();
    const r = await one(s, 'XREAD', 'BLOCK', '200', 'STREAMS', 'nokey', '$');
    const dt = Date.now() - t0;
    if (r !== null) throw new Error('expected nil, got ' + JSON.stringify(r));
    if (dt > 1500) throw new Error('block took too long: ' + dt + 'ms (ms treated as seconds?)');
    if (dt < 120) throw new Error('returned too fast: ' + dt + 'ms');
  });

  await check('ZREVRANGEBYSCORE order', async (s) => {
    await one(s, 'ZADD', 'z', '1', 'a', '2', 'b', '3', 'c');
    eq(await one(s, 'ZREVRANGEBYSCORE', 'z', '+inf', '-inf'), ['c', 'b', 'a']);
    eq(await one(s, 'ZREVRANGEBYSCORE', 'z', '+inf', '-inf', 'WITHSCORES'), ['c', '3', 'b', '2', 'a', '1']);
  });

  await check('ZRANDMEMBER positive count unique', async (s) => {
    await one(s, 'ZADD', 'z', '1', 'a', '2', 'b', '3', 'c');
    const r = await one(s, 'ZRANDMEMBER', 'z', '3');
    eq([...r].sort(), ['a', 'b', 'c']);
  });

  await check('GEORADIUS works', async (s) => {
    await one(s, 'GEOADD', 'geo', '-73.99', '40.71', 'nyc', '-74.0', '40.72', 'n2');
    const r = await one(s, 'GEORADIUS', 'geo', '-73.99', '40.71', '5', 'km', 'ASC');
    const members = (Array.isArray(r) ? r : []).map(x => Buffer.isBuffer(x) ? x.toString() : String(x));
    if (!members.includes('nyc')) throw new Error('bad radius: ' + JSON.stringify(members));
  });

  await check('GEOSEARCH WITHDIST unit is km (query unit)', async (s) => {
    await one(s, 'GEOADD', 'geo', '0', '0', 'a', '0.01', '0', 'b');
    const r = await one(s, 'GEOSEARCH', 'geo', 'FROMLONLAT', '0', '0', 'BYRADIUS', '5', 'km', 'WITHDIST', 'ASC');
    const d = Number(r[1][1]);
    if (!(d > 0.5 && d < 2)) throw new Error('dist not in km: ' + JSON.stringify(r));
  });

  await check('XTRIM without MAXLEN errors (not wipe)', async (s) => {
    await one(s, 'XADD', 'st', '*', 'f', 'v');
    const r = await one(s, 'XTRIM', 'st', 'BALONEY', 'x', 'y');
    isErr(r);
    eq(await one(s, 'XLEN', 'st'), 1);
  });

  await check('XREAD odd args errors', async (s) => {
    isErr(await one(s, 'XREAD', 'STREAMS', 'onlykey'));
  });

  await check('BITOP invalid op errors', async (s) => {
    await one(s, 'SET', 'b1', 'a');
    isErr(await one(s, 'BITOP', 'FOO', 'dest', 'b1'));
  });

  await check('ZADD trailing lone score errors', async (s) => {
    isErr(await one(s, 'ZADD', 'z', '1', 'a', '2'));
  });

  await check('ZCOUNT arity', async (s) => {
    isErr(await one(s, 'ZCOUNT', 'z'));
  });

  await check('HSCAN wrong type errors', async (s) => {
    await one(s, 'SET', 'str', 'v');
    isErr(await one(s, 'HSCAN', 'str', '0'), 'WRONGTYPE');
  });

  await check('GETSET wrong type errors', async (s) => {
    await one(s, 'RPUSH', 'l', 'a');
    isErr(await one(s, 'GETSET', 'l', 'v'), 'WRONGTYPE');
  });

  await check('WATCH+DEL aborts EXEC', async (s) => {
    const s2 = await conn();
    await one(s, 'SET', 'wk', '1');
    eq(await one(s, 'WATCH', 'wk'), 'OK');
    await one(s2, 'DEL', 'wk');
    await one(s, 'MULTI');
    await one(s, 'SET', 'wk', '2');
    eq(await one(s, 'EXEC'), null);
    s2.end();
  });

  await check('EXEC rejects SUBSCRIBE queue (error, stays usable)', async (s) => {
    await one(s, 'MULTI');
    const r = await one(s, 'SUBSCRIBE', 'ch');
    isErr(r);
    await one(s, 'DISCARD');
    eq(await one(s, 'PING'), 'PONG');
  });

  await check('EVAL redis.call missing key returns nil, bad cmd throws', async (s) => {
    eq(await one(s, 'EVAL', "return redis.call('get','nope');", '0'), null);
    const r = await one(s, 'EVAL', "return redis.call('nosuchcmd');", '0');
    isErr(r);
  });

  await check('EVAL SET returns OK string (not object)', async (s) => {
    eq(await one(s, 'EVAL', "return redis.call('set','ek','v');", '0'), 'OK');
  });

  await check('PUBLISH not persisted in AOF', async (s) => {
    await one(s, 'PUBLISH', 'ch', 'hello');
    const aof = fs.readFileSync(path.join(DIR, 'appendonly.aof'), 'utf8');
    if (/PUBLISH/i.test(aof)) throw new Error('PUBLISH found in AOF');
  });

  await check('SELECT/AOF keeps DB separation after restart', async (s) => {
    await one(s, 'SELECT', '5');
    await one(s, 'SET', 'dbkey', 'five');
    await one(s, 'SELECT', '0');
    await one(s, 'SAVE');
    // restart server (keeps data dir)
    await restartServer();
    const s2 = await conn();
    eq(await one(s2, 'GET', 'dbkey'), null);
    await one(s2, 'SELECT', '5');
    eq(await one(s2, 'GET', 'dbkey'), 'five');
    await one(s2, 'SELECT', '0');
    s2.end();
  });

  await check('GEO survives RDB restart', async (s) => {
    const s2 = await conn();
    await one(s2, 'FLUSHALL');
    await one(s2, 'GEOADD', 'geo', '-73.99', '40.71', 'nyc');
    await one(s2, 'SAVE');
    await restartServer();
    const s3 = await conn();
    eq(await one(s3, 'GEODIST', 'geo', 'nyc', 'nyc'), '0.0000');
    s3.end(); s2.end();
  });

  await check('DUMP/RESTORE zset roundtrip', async (s) => {
    await one(s, 'ZADD', 'z', '1', 'a', '2', 'b');
    // DUMP via raw socket to get bulk string
    const s2 = await conn();
    const [dump] = await convo(s2, [raw(['DUMP', 'z'])]);
    s2.end();
    const dumpStr = dump.toString();
    await one(s, 'DEL', 'z');
    eq(await one(s, 'RESTORE', 'z', '0', dumpStr), 'OK');
    eq(await one(s, 'ZRANGE', 'z', '0', '-1', 'WITHSCORES'), ['a', '1', 'b', '2']);
  });

  await check('SLOWLOG only logs slow (fast cmds not all logged)', async (s) => {
    await one(s, 'SLOWLOG', 'RESET');
    for (let i = 0; i < 5; i++) await one(s, 'PING');
    const n = await one(s, 'SLOWLOG', 'LEN');
    if (n !== 0) throw new Error('fast commands logged: len=' + n);
  });

  await check('empty array *0 does not crash, next cmd works', async (s) => {
    s.write(Buffer.from('*0\r\n'));
    await new Promise(r => setTimeout(r, 200));
    eq(await one(s, 'PING'), 'PONG');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  server.kill();
  try { removeTempDir(DIR); } catch (e) { console.error(`cleanup: ${e.message}`); failed++; }
  if (failures.length) console.log('failed tests: ' + failures.join('; '));
  process.exit(failed ? 1 : 0);
}
main().catch(e => {
  console.error('HARNESS FATAL' + (currentTest ? ` during/after [${currentTest}]` : '') + ': ' + ((e && e.stack) || e));
  try { if (server) console.error(`server state: ${server.describe()}`); } catch {}
  try { if (server) server.kill(); } catch {}
  process.exit(2);
});
