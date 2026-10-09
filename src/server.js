'use strict';
/**
 * Pulse Redis Clone — TCP server, RESP, pub/sub, blocking ops, replication, persistence.
 * Zero dependencies. Run: node src/server.js [--port 6379] [--dir ./data]
 */
const net = require('net');
const path = require('path');
const { Parser, encode } = require('./resp');
const { DataStore } = require('./datastore');
const { execute, isWrite } = require('./commands');
const { Persistence } = require('./persistence');
const H = require('./helpers');

const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const PORT = Number(argVal('--port', process.env.PORT || 6379));
const DATA_DIR = argVal('--dir', path.join(__dirname, '..', 'data'));

class Server {
  constructor() {
    this.port = PORT;
    this.store = new DataStore({ numDbs: 16 });
    this.config = {
      port: PORT, hz: 10, appendonly: 'yes', save: '900 1 300 10 60 100',
      'maxmemory-policy': 'noeviction', maxmemory: '0', requirepass: '', databases: '16',
    };
    this.conns = new Set();
    this.nextId = 1;
    this.stats = { startTime: Date.now(), connections: 0, commands: 0, netIn: 0, netOut: 0, hits: 0, misses: 0, expired: 0, evicted: 0 };
    this.slowlog = [];
    this.slowId = 1;
    this.slowlogThresholdUs = 10000; // log commands slower than 10ms (redis default slowlog-log-slower-than)
    this.scripts = new Map();
    this.channels = new Map(); // channel -> Set<client>
    this.patterns = new Map(); // pattern -> Set<client>
    this.monitors = new Set();
    this.waiters = []; // {client, keys:Set, timer, cb}
    this.role = 'master';
    this.slaves = new Set(); // replication clients (SUBSCRIBE to writes)
    this.replOffset = 0;
    this.masterSock = null;
    this.persist = new Persistence(this, { dir: DATA_DIR });
  }

  isWrite(cmd) { return isWrite(cmd); }

  touchWatch(dbIdx, key) {
    const tag = `${dbIdx}:${key}`;
    for (const cl of this.conns) {
      if (cl.watched && cl.watched.has(tag)) cl.dirtyWatch = true;
    }
  }

  blockedCount() { return this.waiters.length; }

  subscribe(client, channel) {
    if (!this.channels.has(channel)) this.channels.set(channel, new Set());
    this.channels.get(channel).add(client);
    client.channels.add(channel);
  }
  unsubscribe(client, channel) {
    this.channels.get(channel)?.delete(client);
    if (!this.channels.get(channel)?.size) this.channels.delete(channel);
    client.channels.delete(channel);
  }
  psubscribe(client, pattern) {
    if (!this.patterns.has(pattern)) this.patterns.set(pattern, new Set());
    this.patterns.get(pattern).add(client);
    client.patterns.add(pattern);
  }
  punsubscribe(client, pattern) {
    this.patterns.get(pattern)?.delete(client);
    if (!this.patterns.get(pattern)?.size) this.patterns.delete(pattern);
    client.patterns.delete(pattern);
  }

  publish(channel, message) {
    let n = 0;
    const subs = this.channels.get(channel);
    if (subs) for (const cl of [...subs]) { this.pushTo(cl, ['message', channel, message]); n++; }
    const { globToRegExp } = require('./datastore');
    for (const [pat, set] of this.patterns) {
      let re;
      try { re = globToRegExp(pat); } catch { continue; }
      if (re.test(channel)) for (const cl of [...set]) { this.pushTo(cl, ['pmessage', pat, channel, message]); n++; }
    }
    return n;
  }

  pushTo(client, value) {
    try {
      const buf = Buffer.isBuffer(value) ? value : encode(value);
      if (client.socket && !client.socket.destroyed) { client.socket.write(buf); this.stats.netOut += buf.length; }
    } catch {}
  }

  /** Wake blocking clients waiting on key(s). */
  signalKey(dbIdx, key) { this.wakeWaiters(dbIdx, key); }
  afterListPush(dbIdx, key) { this.wakeWaiters(dbIdx, key); }
  afterStreamAdd(dbIdx, key) { this.wakeWaiters(dbIdx, key); }
  wakeWaiters(dbIdx, key) {
    const ready = this.waiters.filter(w => w.client.db === dbIdx && w.keys.has(key));
    for (const w of ready) { try { w.fire(key); } catch {} }
  }
  // timeoutMs: milliseconds to block (0 = forever). One client may hold several waiters.
  waitForKey(client, keys, timeoutMs, cb) {
    const set = new Set(Array.isArray(keys) ? keys : [keys]);
    const w = { client, keys: set, cb, timer: null, fired: false };
    const ms = Number(timeoutMs);
    const fire = (key) => {
      if (w.fired) return;
      w.fired = true;
      clearTimeout(w.timer);
      this.waiters = this.waiters.filter(x => x !== w);
      if (client.waiters) client.waiters.delete(w);
      try { cb(key); } catch {}
    };
    w.timer = setTimeout(() => fire(null), ms > 0 ? ms : 2147483647);
    w.fire = fire;
    this.waiters.push(w);
    if (!client.waiters) client.waiters = new Set();
    client.waiters.add(w);
  }
  cancelWaiters(client) {
    if (!client.waiters) return;
    for (const w of [...client.waiters]) {
      clearTimeout(w.timer);
      w.fired = true;
      this.waiters = this.waiters.filter(x => x !== w);
    }
    client.waiters.clear();
  }

  /** Execute write during AOF replay / replica feed (no networking).
   * opts.db selects the logical DB (callers track SELECT themselves). */
  applyWrite(argv, opts = {}) {
    const db = opts.db || 0;
    if (argv[0] && String(argv[0]).toUpperCase() === 'SELECT') return 'OK'; // db tracked by caller
    const fake = { db, id: 0, inMulti: null, watched: new Map(), dirtyWatch: false, channels: new Set(), patterns: new Set(), respVersion: 2, authed: true };
    try { return this.runCommand(fake, argv.map(String), true); }
    catch (e) { if (!opts.replay) throw e; return null; }
  }

  // Commands that must never be queued inside MULTI/EXEC: they either
  // change connection mode (DIRECT replies) or could block the event loop.
  static get noQueue() {
    return new Set(['subscribe', 'unsubscribe', 'psubscribe', 'punsubscribe',
      'monitor', 'psync', 'shutdown', 'blpop', 'brpop', 'blmove',
      'bzpopmin', 'bzpopmax']);
  }

  runCommand(client, argv, silent = false) {
    const t0 = Date.now();
    const send = (v) => {
      const buf = Buffer.isBuffer(v) ? v : encode(v);
      if (!silent && client.socket && !client.socket.destroyed) { client.socket.write(buf); this.stats.netOut += buf.length; }
      return H.DIRECT;
    };
    let res;
    try {
      // MULTI queueing (inside try so a rejected queue op returns an error reply, never crashes the socket)
      const upper0 = String(argv[0] || '').toUpperCase();
      if (client.inMulti && upper0 !== 'EXEC' && upper0 !== 'DISCARD' && upper0 !== 'MULTI') {
        const lname = String(argv[0]).toLowerCase();
        if (Server.noQueue.has(lname)) throw new Error(`ERR command '${argv[0]}' cannot be queued in MULTI`);
        if (lname === 'xread' || lname === 'xreadgroup') {
          if (argv.some(x => String(x).toUpperCase() === 'BLOCK')) throw new Error(`ERR command '${argv[0]}' with BLOCK cannot be queued in MULTI`);
        }
        client.inMulti.push(argv.map(String));
        res = { __resp: '+QUEUED\r\n' };
      } else {
        res = execute(this, client, argv.map(String), send);
      }
    } catch (e) {
      res = e instanceof Error ? e : new Error(String(e));
      if (res.message.startsWith('ERR ') || res.message.startsWith('WRONGTYPE') || res.message.startsWith('unknown') || res.message.includes('wrong number') || res.message.includes('syntax')) {
        // keep message as-is (already prefixed correctly mostly)
      } else if (!/^[A-Z-]+\s/.test(res.message)) {
        res = new Error('ERR ' + res.message);
      }
    }
    const dur = Date.now() - t0;
    if (!silent) {
      this.stats.commands++;
      if (dur * 1000 >= this.slowlogThresholdUs) {
        // truncate argv so one giant MSET can't pin megabytes in the slowlog
        const argvs = argv.map(String).slice(0, 32).map(s => (s.length > 128 ? s.slice(0, 128) + '...' : s));
        this.slowlog.push({ id: this.slowId++, ts: Math.floor(Date.now() / 1000), dur: dur * 1000, argv: argvs });
        if (this.slowlog.length > 128) this.slowlog.shift();
      }
    }
    return res;
  }

  afterWrite(argv) {
    // AOF + replication fan-out + monitor (persist.log already bumps dirty)
    try { this.persist.log(argv.map(String)); } catch {}
    this.replOffset++;
    const buf = require('./resp').encodeCommand(argv.map(String));
    for (const slave of [...this.slaves]) {
      try { if (!slave.socket.destroyed) slave.socket.write(buf); } catch { this.slaves.delete(slave); }
    }
    for (const m of this.monitors) {
      try { m.socket.write(encode([String(Math.floor(Date.now() / 1000)), String(m.db), ...argv.map(String)])); } catch {}
    }
  }

  addSlave(client) { this.slaves.add(client); client.isSlave = true; }
  setRole(role) {
    this.role = role;
    if (role === 'master' && this.masterSock) { try { this.masterSock.destroy(); } catch {} this.masterSock = null; }
  }
  replicateFrom(host, port) {
    this.setRole('slave');
    if (this.masterSock) { try { this.masterSock.destroy(); } catch {} }
    const sock = net.createConnection({ host, port }, () => {
      // handshake: REPLCONF + PSYNC
      sock.write(require('./resp').encodeCommand(['REPLCONF', 'listening-port', String(this.port)]));
      sock.write(require('./resp').encodeCommand(['REPLCONF', 'capa', 'eof']));
      sock.write(require('./resp').encodeCommand(['PSYNC', '?', '-1']));
    });
    const parser = new Parser();
    let buf = Buffer.alloc(0);
    let syncDone = false; // false while consuming +OK/FULLRESYNC/RDB handshake
    let rdb = 0;          // replica's current DB (tracked via SELECT)
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // 1) consume handshake lines (+OK / +FULLRESYNC) and optional $ RDB blob
      while (!syncDone && buf.length) {
        if (buf[0] === 43 /* + */) {
          const idx = buf.indexOf('\r\n');
          if (idx === -1) return; // wait for full line
          buf = buf.slice(idx + 2);
          continue;
        }
        if (buf[0] === 36 /* $ */) {
          // RDB bulk payload (we send none, but real masters do) — skip it
          const idx = buf.indexOf('\r\n');
          if (idx === -1) return;
          const len = parseInt(buf.slice(1, idx).toString(), 10);
          if (Number.isNaN(len) || len < 0) { buf = buf.slice(idx + 2); continue; }
          if (buf.length < idx + 2 + len + 2) return; // wait for full blob
          buf = buf.slice(idx + 2 + len + 2);
          continue;
        }
        syncDone = true; // command stream starts here; parser owns the bytes below
      }
      if (!syncDone || !buf.length) return;
      // 2) hand all stream bytes to the incremental parser (never re-inspect mid-stream bytes)
      let cmds;
      try {
        cmds = parser.feed(buf);
      } catch {
        buf = Buffer.alloc(0);
        parser.buf = Buffer.alloc(0);
        return;
      }
      buf = Buffer.alloc(0); // consumed; incomplete tail stays in parser.buf
      for (const argv of cmds) {
        try {
          if (argv[0] && String(argv[0]).toUpperCase() === 'SELECT') { rdb = Number(argv[1]) || 0; continue; }
          this.applyWrite(argv, { db: rdb });
        } catch {}
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => { if (this.masterSock === sock) this.masterSock = null; });
    this.masterSock = sock;
  }

  start() {
    this.persist.init();
    const server = net.createServer((socket) => {
      const client = {
        socket, id: this.nextId++, db: 0, name: '', inMulti: null,
        watched: new Map(), dirtyWatch: false,
        channels: new Set(), patterns: new Set(), subscribed: false,
        respVersion: 2, authed: !this.config.requirepass, monitor: false,
        peer: `${socket.remoteAddress}:${socket.remotePort}`, quit: false, waiters: new Set(),
      };
      this.conns.add(client);
      this.stats.connections++;
      const parser = new Parser();
      socket.on('data', (chunk) => {
        this.stats.netIn += chunk.length;
        // auth gate
        let argvList;
        try { argvList = parser.feed(chunk); }
        catch { try { socket.write('-ERR Protocol error\r\n'); } catch {} parser.buf = Buffer.alloc(0); return; }
        for (const argv of argvList) {
          if (!argv.length) continue;
          // monitor clients see everything
          const upper = String(argv[0]).toUpperCase();
          if (!client.authed && !['AUTH', 'HELLO', 'QUIT'].includes(upper)) {
            socket.write('-NOAUTH Authentication required.\r\n');
            continue;
          }
          const res = this.runCommand(client, argv);
          if (res === H.DIRECT) { /* already replied */ }
          else {
            const buf = Buffer.isBuffer(res) ? res : encode(res);
            socket.write(buf);
            this.stats.netOut += buf.length;
          }
          // replicate + persist write commands (not from slaves, not replay, not queued, not failed?)
          if (!(res instanceof Error) && res !== H.DIRECT && this.isWrite(argv[0]) && !client.isSlave && !client.inMulti) {
            // EXEC handles its own logging; MULTI/queue returns QUEUED (skip)
            if (!(client.inMulti && upper !== 'EXEC')) this.afterWrite(argv);
          }
          if (client.quit) { socket.end(); break; }
        }
      });
      socket.on('close', () => {
        this.conns.delete(client);
        this.monitors.delete(client);
        this.slaves.delete(client);
        this.cancelWaiters(client);
        for (const ch of client.channels) this.channels.get(ch)?.delete(client);
        for (const p of client.patterns) this.patterns.get(p)?.delete(client);
      });
      socket.on('error', () => {});
    });

    server.listen(this.port, () => {
      console.log(`⚡ Pulse Redis Clone listening on port ${this.port}`);
      console.log(`   commands: ${require('./commands').commandCount()} | dbs: 16 | AOF: ${this.persist.aofEnabled ? 'on' : 'off'} | dir: ${DATA_DIR}`);
      console.log(`   connect:  node src/cli.js  (or redis-cli -p ${this.port})`);
    });

    // active expiry
    setInterval(() => {
      const n = this.store.activeExpireCycle();
      this.stats.expired += n;
    }, 100).unref();

    // replica stream: EXEC already logs each sub-command, MULTI itself is not logged. handled in runCommand path.
    return server;
  }
}

if (require.main === module) {
  const s = new Server();
  // CLI flags: --port, --dir, --maxmemory, --requirepass
  const mm = argVal('--maxmemory', null);
  if (mm) s.store.maxmemory = Number(mm) || 0;
  const rp = argVal('--requirepass', null);
  if (rp) s.config.requirepass = rp;
  s.start();
}

module.exports = { Server };
