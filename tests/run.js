'use strict';
/** Integration tests over real TCP. Spawns a server on PORT (env override). */
const net = require('net');
const path = require('path');
const { startServer, connect, removeTempDir, tempDir } = require('./helpers');
const { encodeCommand } = require('../src/resp');

const PORT = Number(process.env.PULSE_TEST_PORT || 16379);
const DIR = process.env.PULSE_TEST_DIR || tempDir('tmpdata');
let server, passed = 0, failed = 0;
let currentTest = '(setup)';

function send(sock, ...argv) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      sock.removeListener('data', onData);
      reject(new Error(`[${currentTest}] reply timeout for: ${argv.map(String).join(' ')}`));
    }, 5000);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const r = tryParse(buf);
      if (r) { clearTimeout(timer); sock.removeListener('data', onData); resolve(r.value); }
    };
    sock.on('data', onData);
    sock.write(encodeCommand(argv));
  });
}
function tryParse(b) {
  const r = parseOne(b, 0);
  return r;
}
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
    return { value: b.slice(eol + 2, eol + 2 + len).toString(), next: eol + 2 + len + 2, raw: b.slice(0, eol + 2 + len + 2) };
  }
  if (t === '*') {
    const n = parseInt(line, 10);
    if (n === -1) return { value: null, next: eol + 2 };
    let cur = eol + 2; const arr = [];
    for (let i = 0; i < n; i++) { const r = parseOne(b, cur); if (!r) return null; arr.push(r.value); cur = r.next; }
    arr._next = cur;
    return { value: arr, next: cur };
  }
  return null;
}

async function check(name, fn) {
  currentTest = name;
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failed++; console.log(`  FAIL - ${name}: ${e.message}`); }
}
function eq(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
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
  let sock;
  try {
    sock = await connect(PORT);
  } catch (e) {
    console.error(`cannot connect: ${e.message}`);
    console.error(`server state: ${server.describe()}`);
    process.exit(2);
  }
  await send(sock, 'FLUSHALL');

  await check('PING', async () => eq(await send(sock, 'PING'), 'PONG'));
  await check('SET/GET', async () => { eq(await send(sock, 'SET', 'foo', 'bar'), 'OK'); eq(await send(sock, 'GET', 'foo'), 'bar'); });
  await check('SET NX/XX + EX', async () => {
    eq(await send(sock, 'SET', 'n1', 'a', 'NX'), 'OK');
    eq(await send(sock, 'SET', 'n1', 'b', 'NX'), null);
    eq(await send(sock, 'SET', 'xx-missing', 'b', 'XX'), null);
  });
  await check('INCR/DECR', async () => { await send(sock, 'SET', 'c', '10'); eq(await send(sock, 'INCR', 'c'), 11); eq(await send(sock, 'INCRBY', 'c', '5'), 16); eq(await send(sock, 'DECRBY', 'c', '6'), 10); });
  await check('EXPIRE/TTL', async () => { await send(sock, 'SET', 'e', '1', 'EX', '100'); const t = await send(sock, 'TTL', 'e'); if (!(t > 0 && t <= 100)) throw new Error('bad ttl ' + t); });
  await check('MSET/MGET', async () => { await send(sock, 'MSET', 'a', '1', 'b', '2'); eq(await send(sock, 'MGET', 'a', 'b', 'missing'), ['1', '2', null]); });
  await check('LIST', async () => { await send(sock, 'DEL', 'l'); await send(sock, 'RPUSH', 'l', '1', '2', '3'); eq(await send(sock, 'LRANGE', 'l', '0', '-1'), ['1', '2', '3']); eq(await send(sock, 'LPOP', 'l'), '1'); });
  await check('HASH', async () => { await send(sock, 'HSET', 'h', 'f1', 'v1', 'f2', 'v2'); eq(await send(sock, 'HGET', 'h', 'f1'), 'v1'); eq(await send(sock, 'HLEN', 'h'), 2); });
  await check('SET type', async () => { await send(sock, 'SADD', 's', 'a', 'b', 'c'); eq(await send(sock, 'SCARD', 's'), 3); eq(await send(sock, 'SISMEMBER', 's', 'a'), 1); });
  await check('ZSET', async () => { await send(sock, 'ZADD', 'z', '1', 'one', '2', 'two'); eq(await send(sock, 'ZSCORE', 'z', 'one'), '1'); eq(await send(sock, 'ZRANGE', 'z', '0', '-1'), ['one', 'two']); });
  await check('BITMAP', async () => { await send(sock, 'SETBIT', 'bm', '7', '1'); eq(await send(sock, 'GETBIT', 'bm', '7'), 1); });
  await check('STREAM', async () => { const id = await send(sock, 'XADD', 'st', '*', 'f', 'v'); if (!id.includes('-')) throw new Error('bad id'); eq(await send(sock, 'XLEN', 'st'), 1); });
  await check('TRANSACTION', async () => { await send(sock, 'MULTI'); await send(sock, 'SET', 'tx', '1'); const r = await send(sock, 'EXEC'); if (!r || r[0] !== 'OK') throw new Error('bad exec ' + JSON.stringify(r)); });
  await check('PUBSUB count', async () => eq(await send(sock, 'PUBLISH', 'ch', 'hi'), 0));
  await check('EVAL', async () => eq(await send(sock, 'EVAL', "redis.call('set','ev','42'); return redis.call('get','ev');", '0'), '42'));
  await check('SCAN', async () => { const r = await send(sock, 'SCAN', '0'); if (!Array.isArray(r) || r.length !== 2) throw new Error('bad scan'); });
  await check('INFO', async () => { const r = await send(sock, 'INFO', 'server'); if (!String(r).includes('redis_version')) throw new Error('bad info'); });
  await check('GEO', async () => { await send(sock, 'GEOADD', 'geo', '-73.99', '40.71', 'nyc'); const d = await send(sock, 'GEODIST', 'geo', 'nyc', 'nyc'); eq(d, '0.0000'); });

  console.log(`\n${passed} passed, ${failed} failed`);
  try { sock.end(); } catch {}
  server.kill();
  try { removeTempDir(DIR); } catch (e) { console.error(`cleanup: ${e.message}`); failed++; }
  process.exit(failed ? 1 : 0);
}
main().catch(e => {
  console.error(e && e.stack ? e.stack : e);
  try { if (server) console.error(`server state: ${server.describe()}`); } catch {}
  try { if (server) server.kill(); } catch {}
  process.exit(1);
});
