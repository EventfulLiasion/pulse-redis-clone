'use strict';
/** Core + keys + strings + lists + hashes */
const crypto = require('crypto');
const H = require('./helpers');
const { newZSet, zsetAdd } = require('./datastore');

function registerCore(cmds) {
  // ---------- connection ----------
  cmds.ping = (srv, c, a) => {
    if (c.subscribed) { return ['pong', a[1] !== undefined ? String(a[1]) : '']; }
    if (a.length === 2) {
      if (c.respVersion === 3) return [String(a[1])];
      return { __resp: '$' + Buffer.byteLength(String(a[1])) + '\r\n' + String(a[1]) + '\r\n' };
    }
    if (c.respVersion === 3) return ['pong'];
    return { __resp: '+PONG\r\n' };
  };
  cmds.echo = (srv, c, a) => { if (a.length !== 2) throw H.WArity('echo'); return String(a[1]); };
  cmds.select = (srv, c, a) => {
    if (a.length !== 2) throw H.WArity('select');
    const i = H.toInt(a[1]);
    if (i === null || i < 0 || i >= srv.store.numDbs) throw new Error('DB index is out of range');
    c.db = i; return { __resp: '+OK\r\n' };
  };
  cmds.auth = (srv, c, a) => {
    if (a.length < 2) throw H.WArity('auth');
    const pass = a.length === 3 ? String(a[2]) : String(a[1]);
    if (!srv.config.requirepass || pass === srv.config.requirepass) { c.authed = true; return { __resp: '+OK\r\n' }; }
    throw new Error('invalid password');
  };
  cmds.hello = (srv, c, a) => {
    // HELLO [protover [AUTH user pass] [SETNAME name]]
    let ver = 2;
    if (a.length >= 2) ver = H.toInt(a[1], 2);
    c.respVersion = ver === 3 ? 3 : 2;
    for (let i = 2; i < a.length; i++) {
      const o = String(a[i]).toUpperCase();
      if (o === 'AUTH' && i + 2 < a.length) {
        const pass = String(a[i + 2]);
        if (srv.config.requirepass && pass !== srv.config.requirepass) throw new Error('invalid password');
        c.authed = true; i += 2;
      } else if (o === 'SETNAME' && i + 1 < a.length) { c.name = String(a[++i]); }
    }
    if (c.respVersion === 3) {
      return { __resp: `%7\r\n$6\r\nserver\r\n$5\r\nredis\r\n$7\r\nversion\r\n$7\r\n7.0.0-c\r\n$5\r\nproto\r\n:3\r\n$2\r\nid\r\n:${c.id}\r\n$4\r\nmode\r\n$10\r\nstandalone\r\n$4\r\nrole\r\n$6\r\nmaster\r\n$7\r\nmodules\r\n*-1\r\n` };
    }
    return ['server', 'redis', 'version', '7.0.0-clone', 'proto', 2, 'id', c.id, 'mode', 'standalone', 'role', 'master', 'modules', []];
  };
  cmds.reset = (srv, c) => { c.db = 0; c.inMulti = null; c.watched = new Map(); c.respVersion = 2; return { __resp: '+RESET\r\n' }; };
  cmds.quit = (srv, c) => { c.quit = true; return { __resp: '+OK\r\n' }; };
  cmds.command = (srv, c, a) => {
    const sub = a[1] ? String(a[1]).toUpperCase() : '';
    if (sub === 'COUNT') return Object.keys(cmds).length;
    if (sub === 'DOCS') return [];
    if (sub === 'INFO') return [];
    if (sub === '') return Object.keys(cmds).map(n => [n, -1, [], 0, 0, 0]);
    return [];
  };

  // ---------- server ----------
  cmds.info = (srv, c, a) => {
    const sec = (a[1] || 'all').toLowerCase();
    const up = Math.floor((Date.now() - srv.stats.startTime) / 1000);
    const mem = process.memoryUsage();
    let s = '';
    const want = (n) => sec === 'all' || sec === 'default' || sec === n;
    if (want('server')) s += `# Server\r\nredis_version:7.0.0-clone\r\nredis_mode:standalone\r\nos:${process.platform}\r\narch_bits:64\r\ntcp_port:${srv.port}\r\nuptime_in_seconds:${up}\r\nuptime_in_days:${Math.floor(up / 86400)}\r\nhz:${srv.config.hz}\r\nconfigured_hz:${srv.config.hz}\r\n\r\n`;
    if (want('clients')) s += `# Clients\r\nconnected_clients:${srv.conns.size}\r\nblocked_clients:${srv.blockedCount()}\r\n\r\n`;
    if (want('memory')) s += `# Memory\r\nused_memory:${mem.heapUsed}\r\nused_memory_human:${(mem.heapUsed / 1048576).toFixed(2)}M\r\nmaxmemory:${srv.store.maxmemory}\r\nmaxmemory_policy:${srv.store.maxmemoryPolicy}\r\nmem_allocator:node\r\n\r\n`;
    if (want('persistence')) s += `# Persistence\r\nloading:0\r\nrdb_changes_since_last_save:${srv.persist.dirty}\r\nrdb_last_save_time:${Math.floor(srv.persist.lastSave / 1000)}\r\naof_enabled:${srv.persist.aofEnabled ? 1 : 0}\r\naof_write_errors:${srv.persist.writeErrors}\r\naof_last_write_status:${srv.persist.writeErrors ? 'err' : 'ok'}\r\naof_last_error:${srv.persist.lastError ? String(srv.persist.lastError).replace(/[\r\n]/g, ' ') : 'none'}\r\n\r\n`;
    if (want('stats')) s += `# Stats\r\ntotal_connections_received:${srv.stats.connections}\r\ntotal_commands_processed:${srv.stats.commands}\r\ninstantaneous_ops_per_sec:0\r\ntotal_net_input_bytes:${srv.stats.netIn}\r\ntotal_net_output_bytes:${srv.stats.netOut}\r\nkeyspace_hits:${srv.stats.hits}\r\nkeyspace_misses:${srv.stats.misses}\r\nexpired_keys:${srv.stats.expired}\r\nevicted_keys:${srv.stats.evicted}\r\n\r\n`;
    if (want('replication')) s += `# Replication\r\nrole:${srv.role}\r\nconnected_slaves:${srv.slaves.size}\r\nmaster_replid:8371b4fb1155b71f4a04d3e1bc3e18c4a990aeeb\r\nmaster_repl_offset:${srv.replOffset}\r\n\r\n`;
    if (want('keyspace')) {
      s += `# Keyspace\r\n`;
      for (let i = 0; i < srv.store.numDbs; i++) {
        const n = srv.store.dbsize(i);
        if (n) { let exp = 0; for (const [, e] of srv.store.dbs[i]) if (e.expireAt) exp++; s += `db${i}:keys=${n},expires=${exp},avg_ttl=0\r\n`; }
      }
      s += `\r\n`;
    }
    return s;
  };
  cmds.dbsize = (srv, c) => srv.store.dbsize(c.db);
  cmds.time = () => { const ms = Date.now(); return [String(Math.floor(ms / 1000)), String((ms % 1000) * 1000)]; };
  cmds.lastsave = (srv) => Math.floor(srv.persist.lastSave / 1000);
  cmds.role = (srv) => srv.role === 'master' ? ['master', srv.replOffset, []] : ['slave', '127.0.0.1', 6379, 'connected', 0];
  cmds.client = (srv, c, a) => {
    const sub = (a[1] || '').toUpperCase();
    if (sub === 'ID') return c.id;
    if (sub === 'GETNAME') return c.name ? c.name : null;
    if (sub === 'SETNAME') { c.name = a[2] ? String(a[2]) : ''; return { __resp: '+OK\r\n' }; }
    if (sub === 'LIST') {
      let out = '';
      for (const cl of srv.conns) out += `id=${cl.id} addr=${cl.peer} name=${cl.name || ''} db=${cl.db} sub=${cl.channels.size + cl.patterns.size}\n`;
      return out;
    }
    if (sub === 'INFO') return `id=${c.id}\naddr=${c.peer}\nname=${c.name || ''}\ndb=${c.db}\n`;
    throw new Error('unknown subcommand');
  };
  cmds.config = (srv, c, a) => {
    const sub = (a[1] || '').toUpperCase();
    if (sub === 'GET') {
      const pat = String(a[2] || '*').toLowerCase().replace(/\*/g, '.*');
      const re = new RegExp('^' + pat + '$');
      const out = [];
      for (const [k, v] of Object.entries(srv.config)) if (re.test(k.toLowerCase())) out.push(k, String(v));
      return out;
    }
    if (sub === 'SET') {
      for (let i = 2; i + 1 < a.length; i += 2) {
        const k = String(a[i]).toLowerCase(); const v = String(a[i + 1]);
        if (k === 'maxmemory') srv.store.maxmemory = parseMem(v);
        else if (k === 'maxmemory-policy') srv.store.maxmemoryPolicy = v;
        else if (k === 'hz') srv.config.hz = H.toInt(v, 10);
        else if (k === 'appendonly') { srv.config.appendonly = v; srv.persist.aofEnabled = /^(yes|1|true)$/i.test(v); }
        else if (k === 'requirepass') srv.config.requirepass = v;
        else srv.config[k] = v;
      }
      return { __resp: '+OK\r\n' };
    }
    if (sub === 'RESETSTAT') { srv.stats.commands = 0; srv.stats.hits = 0; srv.stats.misses = 0; return { __resp: '+OK\r\n' }; }
    if (sub === 'REWRITE') return { __resp: '+OK\r\n' };
    throw H.Syntax();
  };
  cmds.slowlog = (srv, c, a) => {
    const sub = (a[1] || 'GET').toUpperCase();
    if (sub === 'LEN') return srv.slowlog.length;
    if (sub === 'RESET') { srv.slowlog = []; return { __resp: '+OK\r\n' }; }
    if (sub === 'GET') { const n = a[2] ? H.toInt(a[2], 10) : 10; return srv.slowlog.slice(-n).map(e => [e.id, e.ts, e.dur, e.argv]); }
    throw H.Syntax();
  };
  cmds.monitor = (srv, c, a, send) => { c.monitor = true; srv.monitors.add(c); send({ __resp: '+OK\r\n' }); return H.DIRECT; };
  cmds.flushdb = (srv, c, a) => {
    const async = a[1] && /async/i.test(String(a[1]));
    srv.store.flushdb(c.db); return { __resp: '+OK\r\n' };
  };
  cmds.flushall = (srv) => { srv.store.flushall(); return { __resp: '+OK\r\n' }; };
  cmds.save = (srv) => { srv.persist.saveRDB(); return { __resp: '+OK\r\n' }; };
  cmds.bgsave = (srv, c, a, send) => { setImmediate(() => { try { srv.persist.saveRDB(); } catch (e) { console.error('[persist] BGSAVE failed:', (e && e.message) || e); } }); return 'Background saving started'; };
  cmds.bgrewriteaof = (srv) => { setImmediate(() => { try { srv.persist.rewriteAOF(); } catch (e) { console.error('[persist] BGREWRITEAOF failed:', (e && e.message) || e); } }); return 'Background append only file rewriting started'; };
  cmds.shutdown = (srv, c, a, send) => {
    const nosave = a.some(x => /nosave/i.test(String(x)));
    if (!nosave) { try { srv.persist.saveRDB(); } catch (e) { console.error('[persist] SHUTDOWN save failed, exiting anyway:', (e && e.message) || e); } }
    send({ __resp: '+OK\r\n' });
    setTimeout(() => process.exit(0), 100);
    return H.DIRECT;
  };
  cmds.slaveof = cmds.replicaof = (srv, c, a) => {
    if (a.length !== 3) throw H.WArity('replicaof');
    const host = String(a[1]).toUpperCase(), port = String(a[2]).toUpperCase();
    if (host === 'NO' && port === 'ONE') { srv.setRole('master'); return { __resp: '+OK\r\n' }; }
    srv.replicateFrom(String(a[1]), Number(a[2]));
    return { __resp: '+OK\r\n' };
  };
  cmds.psync = (srv, c, a, send) => {
    // Simplified: FULLRESYNC with empty RDB then stream writes
    send({ __resp: `+FULLRESYNC 8371b4fb1155b71f4a04d3e1bc3e18c4a990aeeb ${srv.replOffset}\r\n` });
    srv.addSlave(c);
    return H.DIRECT;
  };
  cmds.replconf = () => ({ __resp: '+OK\r\n' });
  cmds.wait = () => 0;
  cmds.debug = (srv, c, a) => {
    if (/sleep/i.test(String(a[1] || ''))) { const t = Number(a[2] || 0); const end = Date.now() + t * 1000; while (Date.now() < end); }
    return { __resp: '+OK\r\n' };
  };
  cmds.object = (srv, c, a) => {
    const sub = (a[1] || '').toUpperCase();
    if (sub === 'ENCODING') {
      const e = srv.store.get(c.db, String(a[2])); if (!e) return null;
      if (e.type === 'string') return /^-?\d+$/.test(String(e.value)) ? 'int' : (/^-?\d+\.\d+$/.test(String(e.value)) ? 'embstr' : 'raw');
      if (e.type === 'list') return 'quicklist';
      if (e.type === 'hash') return 'listpack';
      if (e.type === 'set') return 'hashtable';
      if (e.type === 'zset') return 'skiplist';
      return 'stream';
    }
    if (sub === 'IDLETIME') { const e = srv.store.get(c.db, String(a[2])); if (!e) return null; return Math.floor((Date.now() - e.lru) / 1000); }
    if (sub === 'FREQ') { const e = srv.store.get(c.db, String(a[2])); if (!e) return null; return e.freq || 0; }
    if (sub === 'REFCOUNT') return 1;
    throw H.Syntax();
  };

  // ---------- transactions ----------
  cmds.multi = (srv, c) => { if (c.inMulti) throw new Error('MULTI calls can not be nested'); c.inMulti = []; return { __resp: '+OK\r\n' }; };
  cmds.exec = (srv, c, a, send) => {
    if (!c.inMulti) throw new Error('EXEC without MULTI');
    // optimistic-lock check: compare watched versions (covers DEL/expiry/evict paths
    // that never go through touchWatch, not just the dirty flag)
    let aborted = !!c.dirtyWatch;
    if (!aborted) {
      for (const [tag, ver] of c.watched) {
        const sep = tag.indexOf(':');
        const dbi = Number(tag.slice(0, sep)), k = tag.slice(sep + 1);
        if ((srv.store.versions[dbi]?.get(k) || 0) !== ver) { aborted = true; break; }
      }
    }
    const q = c.inMulti; c.inMulti = null;
    c.watched = new Map(); c.dirtyWatch = false;
    if (aborted) return null;
    const results = [];
    for (const argv of q) {
      try { results.push(srv.runCommand(c, argv, true)); }
      catch (e) { results.push(e instanceof Error ? e : new Error(String(e))); }
    }
    // encode manually to preserve errors inside array
    const { encode } = require('./resp');
    const errLine = (m) => {
      const s = String(m || 'error');
      return Buffer.from(`-${/^[A-Z][A-Z0-9-]*(\s|$)/.test(s) ? s : 'ERR ' + s}\r\n`);
    };
    const parts = [Buffer.from(`*${results.length}\r\n`)];
    for (const r of results) {
      if (r === H.DIRECT) parts.push(Buffer.from('+OK\r\n'));
      else if (r instanceof Error) parts.push(errLine(r.message));
      else parts.push(Buffer.isBuffer(encode(r)) ? encode(r) : Buffer.from(String(encode(r))));
    }
    // runCommand already logged? log each write
    for (const argv of q) { if (srv.isWrite(argv[0])) srv.afterWrite(argv); }
    send(parts.length === 1 ? parts[0] : Buffer.concat(parts));
    return H.DIRECT;
  };
  cmds.discard = (srv, c) => { if (!c.inMulti) throw new Error('DISCARD without MULTI'); c.inMulti = null; return { __resp: '+OK\r\n' }; };
  cmds.watch = (srv, c, a) => {
    if (c.inMulti) throw new Error('WATCH inside MULTI is not allowed');
    for (let i = 1; i < a.length; i++) {
      const k = String(a[i]);
      c.watched.set(`${c.db}:${k}`, srv.store.versions[c.db].get(k) || 0);
    }
    return { __resp: '+OK\r\n' };
  };
  cmds.unwatch = (srv, c) => { c.watched = new Map(); c.dirtyWatch = false; return { __resp: '+OK\r\n' }; };

  // ---------- keys ----------
  cmds.del = (srv, c, a) => { if (a.length < 2) throw H.WArity('del'); return srv.store.del(c.db, ...a.slice(1).map(String)); };
  cmds.unlink = (srv, c, a) => { if (a.length < 2) throw H.WArity('unlink'); return srv.store.del(c.db, ...a.slice(1).map(String)); };
  cmds.exists = (srv, c, a) => srv.store.exists(c.db, ...a.slice(1).map(String));
  cmds.expire = (srv, c, a) => {
    if (a.length !== 3 && a.length !== 4) throw H.WArity('expire');
    const e = srv.store.get(c.db, String(a[1])); if (!e) return 0;
    if (!/^-?\d+$/.test(String(a[2]))) throw new Error('value is not an integer or out of range');
    const sec = Number(a[2]);
    if (a[3]) {
      const cond = String(a[3]).toUpperCase();
      if (!['NX', 'XX', 'GT', 'LT'].includes(cond)) throw new Error('syntax error');
      if (cond === 'NX' && e.expireAt) return 0;
      if (cond === 'XX' && !e.expireAt) return 0;
      if (cond === 'GT' && e.expireAt && Date.now() + sec * 1000 <= e.expireAt) return 0;
      if (cond === 'LT') {
        if (!e.expireAt) return 0; // no TTL -> LT never sets
        if (Date.now() + sec * 1000 >= e.expireAt) return 0;
      }
    }
    if (sec <= 0) { srv.store.del(c.db, String(a[1])); return 1; } // past timeout deletes
    e.expireAt = Date.now() + sec * 1000; srv.touchWatch(c.db, String(a[1])); return 1;
  };
  cmds.expireat = (srv, c, a) => {
    if (a.length !== 3 && a.length !== 4) throw H.WArity('expireat');
    if (!/^-?\d+$/.test(String(a[2]))) throw new Error('value is not an integer or out of range');
    const ts = Number(a[2]);
    const e = srv.store.get(c.db, String(a[1])); if (!e) return 0;
    if (a[3]) {
      const cond = String(a[3]).toUpperCase();
      if (!['NX', 'XX', 'GT', 'LT'].includes(cond)) throw new Error('syntax error');
      if (cond === 'NX' && e.expireAt) return 0;
      if (cond === 'XX' && !e.expireAt) return 0;
      if (cond === 'GT' && e.expireAt && ts * 1000 <= e.expireAt) return 0;
      if (cond === 'LT') { if (!e.expireAt) return 0; if (ts * 1000 >= e.expireAt) return 0; }
    }
    if (ts * 1000 <= Date.now()) { srv.store.del(c.db, String(a[1])); return 1; }
    e.expireAt = ts * 1000; srv.touchWatch(c.db, String(a[1])); return 1;
  };
  cmds.pexpire = (srv, c, a) => {
    if (a.length !== 3 && a.length !== 4) throw H.WArity('pexpire');
    if (!/^-?\d+$/.test(String(a[2]))) throw new Error('value is not an integer or out of range');
    const ms = Number(a[2]);
    const e = srv.store.get(c.db, String(a[1])); if (!e) return 0;
    if (a[3]) {
      const cond = String(a[3]).toUpperCase();
      if (!['NX', 'XX', 'GT', 'LT'].includes(cond)) throw new Error('syntax error');
      if (cond === 'NX' && e.expireAt) return 0;
      if (cond === 'XX' && !e.expireAt) return 0;
      if (cond === 'GT' && e.expireAt && Date.now() + ms <= e.expireAt) return 0;
      if (cond === 'LT') { if (!e.expireAt) return 0; if (Date.now() + ms >= e.expireAt) return 0; }
    }
    if (ms <= 0) { srv.store.del(c.db, String(a[1])); return 1; }
    e.expireAt = Date.now() + ms; srv.touchWatch(c.db, String(a[1])); return 1;
  };
  cmds.pexpireat = (srv, c, a) => {
    if (a.length !== 3 && a.length !== 4) throw H.WArity('pexpireat');
    if (!/^-?\d+$/.test(String(a[2]))) throw new Error('value is not an integer or out of range');
    const ts = Number(a[2]);
    const e = srv.store.get(c.db, String(a[1])); if (!e) return 0;
    if (a[3]) {
      const cond = String(a[3]).toUpperCase();
      if (!['NX', 'XX', 'GT', 'LT'].includes(cond)) throw new Error('syntax error');
      if (cond === 'NX' && e.expireAt) return 0;
      if (cond === 'XX' && !e.expireAt) return 0;
      if (cond === 'GT' && e.expireAt && ts <= e.expireAt) return 0;
      if (cond === 'LT') { if (!e.expireAt) return 0; if (ts >= e.expireAt) return 0; }
    }
    if (ts <= Date.now()) { srv.store.del(c.db, String(a[1])); return 1; }
    e.expireAt = ts; srv.touchWatch(c.db, String(a[1])); return 1;
  };
  cmds.ttl = (srv, c, a) => { if (a.length !== 2) throw H.WArity('ttl'); const ms = srv.store.ttlMs(c.db, String(a[1])); if (ms < 0) return ms; return Math.floor(ms / 1000); };
  cmds.pttl = (srv, c, a) => { if (a.length !== 2) throw H.WArity('pttl'); return srv.store.ttlMs(c.db, String(a[1])); };
  cmds.persist = (srv, c, a) => { if (a.length !== 2) throw H.WArity('persist'); const e = srv.store.get(c.db, String(a[1])); if (!e) return 0; if (e.expireAt == null) return 0; e.expireAt = null; srv.touchWatch(c.db, String(a[1])); return 1; };
  cmds.keys = (srv, c, a) => { if (a.length !== 2) throw H.WArity('keys'); return srv.store.keys(c.db, String(a[1])); };
  cmds.scan = (srv, c, a) => scanImpl(srv, c, a, 'all');
  cmds.type = (srv, c, a) => { if (a.length !== 2) throw H.WArity('type'); const m = { string: 'string', list: 'list', hash: 'hash', set: 'set', zset: 'zset', stream: 'stream' }; return m[srv.store.typeOf(c.db, String(a[1]))] || 'none'; };
  cmds.rename = (srv, c, a) => {
    if (a.length !== 3) throw H.WArity('rename');
    const s = String(a[1]), d = String(a[2]);
    if (s === d) return { __resp: '+OK\r\n' };
    const e = srv.store.get(c.db, s); if (!e) throw new Error('no such key');
    const dst = srv.store.get(c.db, d); // expiry-aware; frees dst memory below
    if (dst) srv.store.del(c.db, d);
    srv.store.dbs[c.db].set(d, e); srv.store.dbs[c.db].delete(s);
    srv.touchWatch(c.db, s); srv.touchWatch(c.db, d); return { __resp: '+OK\r\n' };
  };
  cmds.renamenx = (srv, c, a) => {
    if (a.length !== 3) throw H.WArity('renamenx');
    if (srv.store.get(c.db, String(a[2]))) return 0;
    const e = srv.store.get(c.db, String(a[1])); if (!e) throw new Error('no such key');
    srv.store.dbs[c.db].set(String(a[2]), e); srv.store.dbs[c.db].delete(String(a[1])); return 1;
  };
  cmds.move = (srv, c, a) => {
    if (a.length !== 3) throw H.WArity('move');
    const dst = H.toInt(a[2], null);
    if (dst === null || dst < 0 || dst >= srv.store.numDbs) throw new Error('value is not an integer or out of range');
    const e = srv.store.get(c.db, String(a[1])); if (!e) return 0;
    if (srv.store.get(dst, String(a[1]))) return 0;
    srv.store.del(c.db, String(a[1]));
    srv.store.dbs[dst].set(String(a[1]), e);
    srv.store.memoryUsed += e._mem || 0;
    srv.store._bump(dst, String(a[1]));
    srv.touchWatch(c.db, String(a[1])); srv.touchWatch(dst, String(a[1]));
    return 1;
  };
  cmds.copy = (srv, c, a) => {
    // COPY src dst [DB d] [REPLACE]
    if (a.length < 3) throw H.WArity('copy');
    let replace = false, db = c.db;
    for (let i = 3; i < a.length; i++) {
      const o = String(a[i]).toUpperCase();
      if (o === 'REPLACE') replace = true;
      else if (o === 'DB' && i + 1 < a.length) {
        db = H.toInt(a[++i], null);
        if (db === null || db < 0 || db >= srv.store.numDbs) throw new Error('value is not an integer or out of range');
      } else throw new Error('syntax error');
    }
    const e = srv.store.get(c.db, String(a[1])); if (!e) return 0;
    if (srv.store.get(db, String(a[2])) && !replace) return 0;
    // deep copy into a FRESH entry (never alias the source object)
    let val;
    if (e.type === 'list') val = [...e.value];
    else if (e.type === 'hash') val = new Map(e.value);
    else if (e.type === 'set') val = new Set(e.value);
    else if (e.type === 'zset') {
      val = { map: new Map(e.value.map), sorted: e.value.sorted.map(x => ({ ...x })) };
    }
    else if (e.type === 'stream') val = JSON.parse(JSON.stringify(e.value));
    else val = String(e.value);
    srv.store.set(db, String(a[2]), e.type, val, e.expireAt ?? null);
    const cp = srv.store.get(db, String(a[2]));
    if (e.type === 'zset' && e.geo) cp.geo = new Map(e.geo);
    srv.touchWatch(db, String(a[2]));
    return 1;
  };
  cmds.randomkey = (srv, c) => srv.store.randomKey(c.db);
  cmds.dump = (srv, c, a) => {
    if (a.length !== 2) throw H.WArity('dump');
    const e = srv.store.get(c.db, String(a[1])); if (!e) return null;
    const { serializeValue } = require('./datastore');
    const payload = { t: e.type, v: serializeValue(e.type, e.value, e) };
    if (e.type === 'zset' && e.geo) payload.g = [...e.geo.entries()];
    return Buffer.from(JSON.stringify(payload)).toString('base64');
  };
  cmds.restore = (srv, c, a) => {
    if (a.length < 4) throw H.WArity('restore');
    if (!/^\d+$/.test(String(a[2]))) throw new Error('value is not an integer or out of range');
    const ttl = Number(a[2]);
    let obj;
    try { obj = JSON.parse(Buffer.from(String(a[3]), 'base64').toString()); }
    catch { throw new Error('DUMP payload version or checksum are wrong'); }
    if (!obj || !['string', 'list', 'hash', 'set', 'zset', 'stream'].includes(obj.t)) throw new Error('DUMP payload version or checksum are wrong');
    let val = obj.v;
    try {
      if (obj.t === 'hash') val = new Map(val);
      else if (obj.t === 'set') val = new Set(val);
      else if (obj.t === 'list') val = [...val];
      else if (obj.t === 'string') val = String(val);
      else if (obj.t === 'zset') {
        const m = new Map(val.map || []);
        val = { map: m, sorted: [...m.entries()].map(([mm, s]) => ({ m: mm, s: Number(s) })).sort((x, y) => x.s - y.s || (x.m < y.m ? -1 : 1)) };
      }
    } catch { throw new Error('DUMP payload version or checksum are wrong'); }
    const ent = srv.store.set(c.db, String(a[1]), obj.t, val, ttl ? Date.now() + ttl : null);
    if (obj.t === 'zset' && Array.isArray(obj.g)) ent.geo = new Map(obj.g);
    srv.touchWatch(c.db, String(a[1]));
    return { __resp: '+OK\r\n' };
  };
  cmds.sort = (srv, c, a) => {
    if (a.length < 2) throw H.WArity('sort');
    const key = String(a[1]);
    let by = null, limit = null, get = [], desc = false, alpha = false, store = null;
    for (let i = 2; i < a.length; i++) {
      const o = String(a[i]).toUpperCase();
      if (o === 'BY' && i + 1 < a.length) by = String(a[++i]);
      else if (o === 'LIMIT' && i + 2 < a.length) { limit = [Number(a[++i]), Number(a[++i])]; }
      else if (o === 'GET' && i + 1 < a.length) get.push(String(a[++i]));
      else if (o === 'DESC') desc = true;
      else if (o === 'ASC') desc = false;
      else if (o === 'ALPHA') alpha = true;
      else if (o === 'STORE' && i + 1 < a.length) store = String(a[++i]);
    }
    const e = srv.store.get(c.db, key); if (!e) return [];
    let items = e.type === 'list' ? [...e.value] : e.type === 'set' ? [...e.value] : e.type === 'zset' ? e.value.sorted.map(x => x.m) : [];
    if (by && by !== 'nosort') {
      items.sort((x, y) => {
        const kx = srv.store.get(c.db, by.replace('*', x)); const ky = srv.store.get(c.db, by.replace('*', y));
        const vx = kx ? String(kx.value) : ''; const vy = ky ? String(ky.value) : '';
        return alpha ? (vx < vy ? -1 : 1) : (Number(vx) - Number(vy));
      });
    } else items.sort((x, y) => alpha ? (String(x) < String(y) ? -1 : 1) : (Number(x) - Number(y)));
    if (desc) items.reverse();
    if (limit) items = items.slice(limit[0] < 0 ? Math.max(0, items.length + limit[0]) : limit[0], limit[0] + limit[1]);
    let out = items;
    if (get.length) {
      out = [];
      for (const it of items) for (const g of get) {
        if (g === '#') out.push(it);
        else { const k = srv.store.get(c.db, g.replace('*', it)); out.push(k ? String(k.value) : null); }
      }
    }
    if (store) { srv.store.set(c.db, store, 'list', out.map(x => x === null ? '' : String(x))); return out.length; }
    return out;
  };

  // ---------- strings ----------
  cmds.set = (srv, c, a) => {
    if (a.length < 3) throw H.WArity('set');
    const key = String(a[1]); const val = String(a[2]);
    const o = H.parseExpireArgs(a.map(String), 3);
    if (o.nextI !== a.length) throw new Error('syntax error');
    if (o.nx && o.xx) throw new Error('syntax error');
    let expireAt = o.expireAt;
    if (expireAt !== null && !(expireAt > 0)) throw new Error('invalid expire time in set');
    const prev = srv.store.get(c.db, key);
    const exists = !!prev;
    if (o.nx && exists) return null;
    if (o.xx && !exists) return null;
    // KEEPTTL preserves previous TTL (real redis); otherwise use new expireAt
    if (o.persist) expireAt = prev ? (prev.expireAt ?? null) : null;
    let old = null;
    if (o.get) old = prev && prev.type === 'string' ? String(prev.value) : null;
    srv.store.set(c.db, key, 'string', val, expireAt);
    srv.touchWatch(c.db, key);
    if (o.get) return old;
    return { __resp: '+OK\r\n' };
  };
  cmds.get = (srv, c, a) => {
    if (a.length !== 2) throw H.WArity('get');
    const e = srv.store.get(c.db, String(a[1]));
    if (!e) { srv.stats.misses++; return null; }
    if (e.type !== 'string') throw H.WType();
    srv.stats.hits++; return String(e.value);
  };
  cmds.getset = (srv, c, a) => {
    if (a.length !== 3) throw H.WArity('getset');
    const e = srv.store.get(c.db, String(a[1]));
    if (e && e.type !== 'string') throw H.WType();
    const old = e ? String(e.value) : null;
    srv.store.set(c.db, String(a[1]), 'string', String(a[2]));
    srv.touchWatch(c.db, String(a[1]));
    return old;
  };
  cmds.getdel = (srv, c, a) => {
    if (a.length !== 2) throw H.WArity('getdel');
    const e = srv.store.get(c.db, String(a[1]));
    if (!e) return null;
    if (e.type !== 'string') throw H.WType();
    srv.store.del(c.db, String(a[1])); return String(e.value);
  };
  cmds.getex = (srv, c, a) => {
    if (a.length < 2) throw H.WArity('getex');
    const e = srv.store.get(c.db, String(a[1]));
    if (!e) return null;
    if (e.type !== 'string') throw H.WType();
    const { expireAt, persist } = H.parseExpireArgs(a.map(String), 2);
    if (persist) e.expireAt = null; else if (expireAt) e.expireAt = expireAt;
    return String(e.value);
  };
  cmds.mset = (srv, c, a) => {
    if (a.length < 3 || a.length % 2 === 0) throw H.WArity('mset');
    for (let i = 1; i < a.length; i += 2) {
      srv.store.set(c.db, String(a[i]), 'string', String(a[i + 1]));
      srv.touchWatch(c.db, String(a[i]));
    }
    return { __resp: '+OK\r\n' };
  };
  cmds.mget = (srv, c, a) => a.slice(1).map(k => { const e = srv.store.get(c.db, String(k)); return e && e.type === 'string' ? String(e.value) : null; });
  cmds.setnx = (srv, c, a) => { if (a.length !== 3) throw H.WArity('setnx'); if (srv.store.get(c.db, String(a[1]))) return 0; srv.store.set(c.db, String(a[1]), 'string', String(a[2])); srv.touchWatch(c.db, String(a[1])); return 1; };
  cmds.setex = (srv, c, a) => {
    if (a.length !== 4) throw H.WArity('setex');
    if (!/^\d+$/.test(String(a[2])) || Number(a[2]) <= 0) throw new Error('invalid expire time in setex');
    srv.store.set(c.db, String(a[1]), 'string', String(a[3]), Date.now() + Number(a[2]) * 1000);
    srv.touchWatch(c.db, String(a[1]));
    return { __resp: '+OK\r\n' };
  };
  cmds.psetex = (srv, c, a) => {
    if (a.length !== 4) throw H.WArity('psetex');
    if (!/^\d+$/.test(String(a[2])) || Number(a[2]) <= 0) throw new Error('invalid expire time in setex');
    srv.store.set(c.db, String(a[1]), 'string', String(a[3]), Date.now() + Number(a[2]));
    srv.touchWatch(c.db, String(a[1]));
    return { __resp: '+OK\r\n' };
  };
  cmds.append = (srv, c, a) => {
    if (a.length !== 3) throw H.WArity('append');
    const { e } = H.getOrCreate(srv, c, String(a[1]), 'string', () => '');
    e.value = String(e.value) + String(a[2]); e._mem += String(a[2]).length * 2;
    srv.touchWatch(c.db, String(a[1])); return String(e.value).length;
  };
  cmds.strlen = (srv, c, a) => { const e = srv.store.get(c.db, String(a[1])); if (!e) return 0; if (e.type !== 'string') throw H.WType(); return String(e.value).length; };
  cmds.incr = (srv, c, a) => incrBy(srv, c, a[1], 1);
  cmds.decr = (srv, c, a) => incrBy(srv, c, a[1], -1);
  cmds.incrby = (srv, c, a) => { if (a.length !== 3) throw H.WArity('incrby'); const d = H.toInt(a[2]); if (d === null) throw new Error('value is not an integer or out of range'); return incrBy(srv, c, a[1], d); };
  cmds.decrby = (srv, c, a) => { if (a.length !== 3) throw H.WArity('decrby'); const d = H.toInt(a[2]); if (d === null) throw new Error('value is not an integer or out of range'); return incrBy(srv, c, a[1], -d); };
  cmds.incrbyfloat = (srv, c, a) => {
    if (a.length !== 3) throw H.WArity('incrbyfloat');
    const d = H.toFloat(a[2]); if (d === null) throw new Error('value is not a valid float');
    const k = String(a[1]);
    let cur = 0; const e = srv.store.get(c.db, k);
    if (e) { if (e.type !== 'string') throw H.WType(); cur = H.toFloat(e.value); if (cur === null) throw new Error('value is not a valid float'); }
    const nv = cur + d;
    srv.store.set(c.db, k, 'string', trimFloat(nv), e?.expireAt ?? null);
    return trimFloat(nv);
  };
  cmds.getrange = (srv, c, a) => {
    if (a.length !== 4) throw H.WArity('getrange');
    const e = srv.store.get(c.db, String(a[1])); if (!e) return '';
    if (e.type !== 'string') throw H.WType();
    const s = String(e.value); let st = H.toInt(a[2], 0), en = H.toInt(a[3], -1);
    if (st < 0) st = s.length + st; if (en < 0) en = s.length + en;
    st = Math.max(0, st); en = Math.min(s.length - 1, en);
    return st > en ? '' : s.slice(st, en + 1);
  };
  cmds.setrange = (srv, c, a) => {
    if (a.length !== 4) throw H.WArity('setrange');
    const off = H.toInt(a[2], null); if (off === null || off < 0) throw new Error('offset is out of range');
    const { e } = H.getOrCreate(srv, c, String(a[1]), 'string', () => '');
    let s = String(e.value);
    while (s.length < off) s += '\x00';
    s = s.slice(0, off) + String(a[3]) + s.slice(off + String(a[3]).length);
    e.value = s; srv.touchWatch(c.db, String(a[1])); return s.length;
  };
  cmds.substr = cmds.getrange;

  // ---------- lists ----------
  cmds.lpush = (srv, c, a) => { if (a.length < 3) throw H.WArity('lpush'); const { e } = H.getOrCreate(srv, c, String(a[1]), 'list', () => []); for (let i = 2; i < a.length; i++) e.value.unshift(String(a[i])); srv.afterListPush(c.db, String(a[1])); srv.touchWatch(c.db, String(a[1])); return e.value.length; };
  cmds.rpush = (srv, c, a) => { if (a.length < 3) throw H.WArity('rpush'); const { e } = H.getOrCreate(srv, c, String(a[1]), 'list', () => []); for (let i = 2; i < a.length; i++) e.value.push(String(a[i])); srv.afterListPush(c.db, String(a[1])); srv.touchWatch(c.db, String(a[1])); return e.value.length; };
  cmds.lpushx = (srv, c, a) => { if (a.length < 3) throw H.WArity('lpushx'); const e = H.requireEntry(srv, c, String(a[1]), 'list'); if (!e) return 0; for (let i = 2; i < a.length; i++) e.value.unshift(String(a[i])); srv.afterListPush(c.db, String(a[1])); srv.touchWatch(c.db, String(a[1])); return e.value.length; };
  cmds.rpushx = (srv, c, a) => { if (a.length < 3) throw H.WArity('rpushx'); const e = H.requireEntry(srv, c, String(a[1]), 'list'); if (!e) return 0; for (let i = 2; i < a.length; i++) e.value.push(String(a[i])); srv.afterListPush(c.db, String(a[1])); srv.touchWatch(c.db, String(a[1])); return e.value.length; };
  cmds.lpop = (srv, c, a) => {
    if (a.length < 2) throw H.WArity('lpop');
    const e = H.requireEntry(srv, c, String(a[1]), 'list'); if (!e) return null;
    const count = a[2] !== undefined ? H.toInt(a[2], null) : null;
    if (a[2] !== undefined && (count === null || count < 0)) throw new Error('value is not an integer or out of range');
    if (count === null) { const v = e.value.shift(); if (!e.value.length) srv.store.del(c.db, String(a[1])); else srv.touchWatch(c.db, String(a[1])); return v ?? null; }
    const out = e.value.splice(0, count); if (!e.value.length) srv.store.del(c.db, String(a[1])); else srv.touchWatch(c.db, String(a[1])); return out;
  };
  cmds.rpop = (srv, c, a) => {
    if (a.length < 2) throw H.WArity('rpop');
    const e = H.requireEntry(srv, c, String(a[1]), 'list'); if (!e) return null;
    const count = a[2] !== undefined ? H.toInt(a[2], null) : null;
    if (a[2] !== undefined && (count === null || count < 0)) throw new Error('value is not an integer or out of range');
    if (count === null) { const v = e.value.pop(); if (!e.value.length) srv.store.del(c.db, String(a[1])); else srv.touchWatch(c.db, String(a[1])); return v ?? null; }
    const out = []; for (let i = 0; i < count && e.value.length; i++) out.push(e.value.pop());
    if (!e.value.length) srv.store.del(c.db, String(a[1])); else srv.touchWatch(c.db, String(a[1])); return out;
  };
  cmds.llen = (srv, c, a) => { const e = srv.store.get(c.db, String(a[1])); if (!e) return 0; if (e.type !== 'list') throw H.WType(); return e.value.length; };
  cmds.lrange = (srv, c, a) => {
    if (a.length !== 4) throw H.WArity('lrange');
    const e = srv.store.get(c.db, String(a[1])); if (!e) return [];
    if (e.type !== 'list') throw H.WType();
    let st = H.toInt(a[2], 0), en = H.toInt(a[3], -1);
    const n = e.value.length;
    if (st < 0) st += n; if (en < 0) en += n;
    st = Math.max(0, st); en = Math.min(n - 1, en);
    return st > en ? [] : e.value.slice(st, en + 1);
  };
  cmds.lindex = (srv, c, a) => {
    const e = srv.store.get(c.db, String(a[1])); if (!e) return null;
    if (e.type !== 'list') throw H.WType();
    let i = H.toInt(a[2], 0); if (i < 0) i += e.value.length;
    return e.value[i] ?? null;
  };
  cmds.lset = (srv, c, a) => {
    if (a.length !== 4) throw H.WArity('lset');
    const e = H.requireEntry(srv, c, String(a[1]), 'list'); if (!e) throw new Error('no such key');
    let i = H.toInt(a[2], null); if (i === null) throw new Error('value is not an integer or out of range');
    if (i < 0) i += e.value.length;
    if (i < 0 || i >= e.value.length) throw new Error('index out of range');
    e.value[i] = String(a[3]); srv.touchWatch(c.db, String(a[1])); return { __resp: '+OK\r\n' };
  };
  cmds.lrem = (srv, c, a) => {
    if (a.length !== 4) throw H.WArity('lrem');
    const e = srv.store.get(c.db, String(a[1])); if (!e) return 0;
    if (e.type !== 'list') throw H.WType();
    let count = H.toInt(a[2], 0); const target = String(a[3]); let removed = 0;
    if (count === 0) { const nl = e.value.filter(v => { if (v === target) { removed++; return false; } return true; }); e.value = nl; }
    else if (count > 0) { const nl = []; for (const v of e.value) { if (v === target && removed < count) removed++; else nl.push(v); } e.value = nl; }
    else { const nl = []; for (let i = e.value.length - 1; i >= 0; i--) { const v = e.value[i]; if (v === target && removed < -count) removed++; else nl.unshift(v); } e.value = nl; }
    if (!e.value.length) srv.store.del(c.db, String(a[1])); else srv.touchWatch(c.db, String(a[1]));
    return removed;
  };
  cmds.ltrim = (srv, c, a) => {
    if (a.length !== 4) throw H.WArity('ltrim');
    const e = srv.store.get(c.db, String(a[1])); if (!e) return { __resp: '+OK\r\n' };
    if (e.type !== 'list') throw H.WType();
    let st = H.toInt(a[2], 0), en = H.toInt(a[3], -1); const n = e.value.length;
    if (st < 0) st += n; if (en < 0) en += n;
    st = Math.max(0, st); en = Math.min(n - 1, en);
    e.value = st > en ? [] : e.value.slice(st, en + 1);
    if (!e.value.length) srv.store.del(c.db, String(a[1])); else srv.touchWatch(c.db, String(a[1]));
    return { __resp: '+OK\r\n' };
  };
  cmds.lmove = (srv, c, a) => {
    if (a.length !== 5) throw H.WArity('lmove');
    const [src, dst, sdir, ddir] = [String(a[1]), String(a[2]), String(a[3]).toUpperCase(), String(a[4]).toUpperCase()];
    const se = srv.store.get(c.db, src); if (!se) return null;
    if (se.type !== 'list') throw H.WType();
    const val = sdir === 'LEFT' ? se.value.shift() : se.value.pop();
    if (val === undefined) return null;
    if (!se.value.length) srv.store.del(c.db, src);
    const { e: de } = H.getOrCreate(srv, c, dst, 'list', () => []);
    if (ddir === 'LEFT') de.value.unshift(val); else de.value.push(val);
    srv.afterListPush(c.db, dst);
    srv.touchWatch(c.db, src); srv.touchWatch(c.db, dst);
    return val;
  };
  cmds.rpoplpush = (srv, c, a) => { if (a.length !== 3) throw H.WArity('rpoplpush'); return cmds.lmove(srv, c, [a[0], a[1], a[2], 'RIGHT', 'LEFT']); };
  cmds.lpos = (srv, c, a) => {
    if (a.length < 3) throw H.WArity('lpos');
    const e = srv.store.get(c.db, String(a[1])); if (!e) return null;
    if (e.type !== 'list') throw H.WType();
    const target = String(a[2]);
    let rank = 1, count = 1, maxlen = 0;
    for (let i = 3; i < a.length; i++) { const o = String(a[i]).toUpperCase(); if (o === 'RANK' && i + 1 < a.length) rank = H.toInt(a[++i], 1); else if (o === 'COUNT' && i + 1 < a.length) count = H.toInt(a[++i], 1); else if (o === 'MAXLEN' && i + 1 < a.length) maxlen = H.toInt(a[++i], 0); }
    let idxs = [];
    const n = e.value.length;
    const order = rank >= 0 ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
    let seen = 0;
    const lim = maxlen > 0 ? Math.min(n, maxlen) : n;
    for (let k = 0; k < lim; k++) {
      const i = order[k];
      if (e.value[i] === target) { seen++; if (seen >= Math.abs(rank)) { idxs.push(i); if (count !== 0 && idxs.length >= count) break; } }
    }
    if (a.some(x => String(x).toUpperCase() === 'COUNT')) return idxs;
    return idxs.length ? idxs[0] : null;
  };
  cmds.blpop = (srv, c, a, send) => blockPop(srv, c, a, send, 'LEFT');
  cmds.brpop = (srv, c, a, send) => blockPop(srv, c, a, send, 'RIGHT');
  cmds.blmove = (srv, c, a, send) => {
    if (a.length < 6) throw H.WArity('blmove');
    const timeout = Number(a[5]);
    if (!Number.isFinite(timeout) || timeout < 0) throw new Error('timeout is not an integer or out of range');
    const v = cmds.lmove(srv, c, [a[0], a[1], a[2], a[3], a[4]]);
    if (v !== null) return Array.isArray(v) ? v : v;
    srv.waitForKey(c, String(a[1]), timeout * 1000, () => {
      const vv = cmds.lmove(srv, c, [a[0], a[1], a[2], a[3], a[4]]);
      send(vv === null ? null : vv);
    });
    return H.DIRECT;
  };

  // ---------- hashes ----------
  cmds.hset = (srv, c, a) => {
    if (a.length < 4 || a.length % 2 === 1) throw H.WArity('hset');
    const { e } = H.getOrCreate(srv, c, String(a[1]), 'hash', () => new Map());
    let added = 0;
    for (let i = 2; i < a.length; i += 2) { const k = String(a[i]), v = String(a[i + 1]); if (!e.value.has(k)) added++; e.value.set(k, v); }
    srv.touchWatch(c.db, String(a[1])); return added;
  };
  cmds.hmset = cmds.hset;
  cmds.hget = (srv, c, a) => { if (a.length !== 3) throw H.WArity('hget'); const e = srv.store.get(c.db, String(a[1])); if (!e) return null; if (e.type !== 'hash') throw H.WType(); const v = e.value.get(String(a[2])); return v === undefined ? null : String(v); };
  cmds.hmget = (srv, c, a) => { if (a.length < 3) throw H.WArity('hmget'); const e = srv.store.get(c.db, String(a[1])); return a.slice(2).map(f => { if (!e) return null; if (e.type !== 'hash') throw H.WType(); const v = e.value.get(String(f)); return v === undefined ? null : String(v); }); };
  cmds.hgetall = (srv, c, a) => { const e = srv.store.get(c.db, String(a[1])); if (!e) return []; if (e.type !== 'hash') throw H.WType(); const out = []; for (const [k, v] of e.value) out.push(k, String(v)); return out; };
  cmds.hdel = (srv, c, a) => { if (a.length < 3) throw H.WArity('hdel'); const e = srv.store.get(c.db, String(a[1])); if (!e) return 0; if (e.type !== 'hash') throw H.WType(); let n = 0; for (let i = 2; i < a.length; i++) if (e.value.delete(String(a[i]))) n++; if (!e.value.size) srv.store.del(c.db, String(a[1])); return n; };
  cmds.hexists = (srv, c, a) => { const e = srv.store.get(c.db, String(a[1])); if (!e) return 0; if (e.type !== 'hash') throw H.WType(); return e.value.has(String(a[2])) ? 1 : 0; };
  cmds.hlen = (srv, c, a) => { const e = srv.store.get(c.db, String(a[1])); if (!e) return 0; if (e.type !== 'hash') throw H.WType(); return e.value.size; };
  cmds.hkeys = (srv, c, a) => { const e = srv.store.get(c.db, String(a[1])); if (!e) return []; if (e.type !== 'hash') throw H.WType(); return [...e.value.keys()]; };
  cmds.hvals = (srv, c, a) => { const e = srv.store.get(c.db, String(a[1])); if (!e) return []; if (e.type !== 'hash') throw H.WType(); return [...e.value.values()].map(String); };
  cmds.hincrby = (srv, c, a) => {
    if (a.length !== 4) throw H.WArity('hincrby');
    const d = H.toInt(a[3]); if (d === null) throw new Error('value is not an integer or out of range');
    const { e } = H.getOrCreate(srv, c, String(a[1]), 'hash', () => new Map());
    const cur = e.value.get(String(a[2])); let n = 0;
    if (cur !== undefined) { n = H.toInt(cur); if (n === null) throw new Error('hash value is not an integer'); }
    n += d; e.value.set(String(a[2]), String(n)); return n;
  };
  cmds.hincrbyfloat = (srv, c, a) => {
    if (a.length !== 4) throw H.WArity('hincrbyfloat');
    const d = H.toFloat(a[3]); if (d === null) throw new Error('value is not a valid float');
    const { e } = H.getOrCreate(srv, c, String(a[1]), 'hash', () => new Map());
    let cur = 0; const raw = e.value.get(String(a[2]));
    if (raw !== undefined) { cur = H.toFloat(raw); if (cur === null) throw new Error('hash value is not a float'); }
    const nv = trimFloat(cur + d); e.value.set(String(a[2]), nv); return nv;
  };
  cmds.hscan = (srv, c, a) => scanImpl(srv, c, a, 'hash');
  cmds.hstrlen = (srv, c, a) => { const e = srv.store.get(c.db, String(a[1])); if (!e) return 0; if (e.type !== 'hash') throw H.WType(); const v = e.value.get(String(a[2])); return v === undefined ? 0 : String(v).length; };
  cmds.hsetnx = (srv, c, a) => { if (a.length !== 4) throw H.WArity('hsetnx'); const { e } = H.getOrCreate(srv, c, String(a[1]), 'hash', () => new Map()); if (e.value.has(String(a[2]))) return 0; e.value.set(String(a[2]), String(a[3])); return 1; };
  cmds.hrandfield = (srv, c, a) => {
    const e = srv.store.get(c.db, String(a[1])); if (!e) return null;
    if (e.type !== 'hash') throw H.WType();
    const ks = [...e.value.keys()]; if (!ks.length) return null;
    let count = a[2] !== undefined ? H.toInt(a[2], 1) : 1;
    const withv = a.some(x => String(x).toUpperCase() === 'WITHVALUES');
    if (a[2] === undefined) return ks[Math.floor(Math.random() * ks.length)];
    const out = [];
    if (count >= 0) { count = Math.min(count, ks.length); for (let i = 0; i < count; i++) { const k = ks[Math.floor(Math.random() * ks.length)]; out.push(k); if (withv) out.push(String(e.value.get(k))); } }
    else { for (let i = 0; i < -count; i++) { const k = ks[Math.floor(Math.random() * ks.length)]; out.push(k); if (withv) out.push(String(e.value.get(k))); } }
    return out;
  };
}

function incrBy(srv, c, key, delta) {
  key = String(key);
  const e = srv.store.get(c.db, key);
  let cur = 0;
  if (e) { if (e.type !== 'string') throw H.WType(); cur = H.toInt(e.value); if (cur === null) throw new Error('value is not an integer or out of range'); }
  const nv = cur + delta;
  if (!Number.isSafeInteger(nv)) throw new Error('increment or decrement would overflow');
  srv.store.set(c.db, key, 'string', String(nv), e?.expireAt ?? null);
  srv.touchWatch(c.db, key);
  return nv;
}
function trimFloat(n) {
  let s = String(n);
  if (s.includes('e') || s.includes('E')) return s;
  if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  if (s === '-0') s = '0';
  return s;
}
function scanImpl(srv, c, a, kind) {
  // SCAN cursor [MATCH p] [COUNT n] [TYPE t] | HSCAN key cursor ... | SSCAN | ZSCAN
  let key = null, cursorIdx = 1;
  if (kind !== 'all') { key = String(a[1]); cursorIdx = 2; }
  let cursor = H.toInt(a[cursorIdx], 0);
  let match = '*', count = 10, typeFilter = null;
  for (let i = cursorIdx + 1; i < a.length; i++) {
    const o = String(a[i]).toUpperCase();
    if (o === 'MATCH' && i + 1 < a.length) match = String(a[++i]);
    else if (o === 'COUNT' && i + 1 < a.length) count = Math.max(1, H.toInt(a[++i], 10));
    else if (o === 'TYPE' && i + 1 < a.length) typeFilter = String(a[++i]).toLowerCase();
  }
  const { globToRegExp } = require('./datastore');
  const re = globToRegExp(match);
  let items = [];
  if (kind === 'all') {
    const db = srv.store.dbs[c.db];
    for (const [k, e] of db) {
      if (srv.store._isExpired(e)) continue;
      if (typeFilter && e.type !== typeFilter && !(typeFilter === 'string' && e.type === 'string')) continue;
      if (re.test(k)) items.push(k);
    }
  } else {
    const e = srv.store.get(c.db, key);
    if (!e) return ['0', []];
    if (kind === 'hash' && e.type !== 'hash') throw H.WType();
    if (kind === 'set' && e.type !== 'set') throw H.WType();
    if (kind === 'zset' && e.type !== 'zset') throw H.WType();
    if (kind === 'hash' && e.type === 'hash') for (const [k, v] of e.value) { if (re.test(k)) items.push(k, String(v)); }
    if (kind === 'set' && e.type === 'set') for (const m of e.value) { if (re.test(String(m))) items.push(String(m)); }
    if (kind === 'zset' && e.type === 'zset') for (const { m, s } of e.value.sorted) { if (re.test(m)) items.push(m, String(s)); }
  }
  cursor = Number(cursor) || 0;
  const slice = items.slice(cursor, cursor + count);
  const next = cursor + count >= items.length ? '0' : String(cursor + count);
  return [next, slice];
}
function blockPop(srv, c, a, send, dir) {
  if (a.length < 3) throw H.WArity('blpop');
  let timeout = Number(a[a.length - 1]);
  if (!Number.isFinite(timeout) || timeout < 0) throw new Error('timeout is not an integer or out of range');
  const keys = a.slice(1, -1).map(String);
  if (!keys.length) throw H.WArity('blpop');
  for (const k of keys) {
    const e = srv.store.get(c.db, k);
    if (e && e.type === 'list' && e.value.length) {
      const v = dir === 'LEFT' ? e.value.shift() : e.value.pop();
      if (!e.value.length) srv.store.del(c.db, k);
      else srv.touchWatch(c.db, k);
      return [k, v];
    }
    if (e && e.type !== 'list') throw H.WType();
  }
  srv.waitForKey(c, keys, timeout * 1000, (key) => {
    if (key === null) { send(null); return; } // timed out -> nil array
    const e = srv.store.get(c.db, key);
    if (!e || e.type !== 'list' || !e.value.length) { send(null); return; }
    const v = dir === 'LEFT' ? e.value.shift() : e.value.pop();
    if (!e.value.length) srv.store.del(c.db, key);
    else srv.touchWatch(c.db, key);
    send([key, v]);
  });
  return H.DIRECT;
}
function parseMem(v) {
  const m = /^(\d+)(kb|mb|gb|b)?$/i.exec(String(v).trim());
  if (!m) return Number(v) || 0;
  const n = Number(m[1]); const u = (m[2] || 'b').toLowerCase();
  return u === 'kb' ? n * 1024 : u === 'mb' ? n * 1048576 : u === 'gb' ? n * 1073741824 : n;
}

module.exports = { registerCore };
