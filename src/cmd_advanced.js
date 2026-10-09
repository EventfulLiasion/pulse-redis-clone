'use strict';
/** Sets + zsets + streams + bitmaps + HLL + geo + pubsub + scripting */
const vm = require('vm');
const crypto = require('crypto');
const H = require('./helpers');
const { newZSet, zsetAdd } = require('./datastore');

function registerAdvanced(cmds) {
  // ---------- sets ----------
  cmds.sadd = (srv, c, a) => { if (a.length < 3) throw H.WArity('sadd'); const { e } = H.getOrCreate(srv, c, String(a[1]), 'set', () => new Set()); let n = 0; for (let i = 2; i < a.length; i++) { const m = String(a[i]); if (!e.value.has(m)) { e.value.add(m); n++; } } srv.touchWatch(c.db, String(a[1])); return n; };
  cmds.smembers = cmds.smembers = (srv, c, a) => { const e = srv.store.get(c.db, String(a[1])); if (!e) return []; if (e.type !== 'set') throw H.WType(); return [...e.value]; };
  cmds.srem = (srv, c, a) => { if (a.length < 3) throw H.WArity('srem'); const e = srv.store.get(c.db, String(a[1])); if (!e) return 0; if (e.type !== 'set') throw H.WType(); let n = 0; for (let i = 2; i < a.length; i++) if (e.value.delete(String(a[i]))) n++; if (!e.value.size) srv.store.del(c.db, String(a[1])); else srv.touchWatch(c.db, String(a[1])); return n; };
  cmds.scard = (srv, c, a) => { const e = srv.store.get(c.db, String(a[1])); if (!e) return 0; if (e.type !== 'set') throw H.WType(); return e.value.size; };
  cmds.sismember = (srv, c, a) => { const e = srv.store.get(c.db, String(a[1])); if (!e) return 0; if (e.type !== 'set') throw H.WType(); return e.value.has(String(a[2])) ? 1 : 0; };
  cmds.smismember = (srv, c, a) => { if (a.length < 3) throw H.WArity('smismember'); const e = srv.store.get(c.db, String(a[1])); return a.slice(2).map(m => (e && e.type === 'set' && e.value.has(String(m)) ? 1 : 0)); };
  cmds.sunion = (srv, c, a) => setOp(srv, c, a, 'union', false);
  cmds.sinter = (srv, c, a) => setOp(srv, c, a, 'inter', false);
  cmds.sdiff = (srv, c, a) => setOp(srv, c, a, 'diff', false);
  cmds.sunionstore = (srv, c, a) => setOp(srv, c, a, 'union', true);
  cmds.sinterstore = (srv, c, a) => setOp(srv, c, a, 'inter', true);
  cmds.sdiffstore = (srv, c, a) => setOp(srv, c, a, 'diff', true);
  cmds.sintercard = (srv, c, a) => {
    if (a.length < 3) throw H.WArity('sintercard');
    const nkeys = H.toInt(a[1]); const keys = a.slice(2, 2 + nkeys).map(String);
    let limit = 0;
    const li = 2 + nkeys;
    if (a[li] && String(a[li]).toUpperCase() === 'LIMIT') limit = H.toInt(a[li + 1], 0);
    const sets = keys.map(k => { const e = srv.store.get(c.db, k); if (!e) return new Set(); if (e.type !== 'set') throw H.WType(); return e.value; });
    if (!sets.length) return 0;
    let n = 0;
    for (const m of sets[0]) { if (sets.every(s => s.has(m))) { n++; if (limit && n >= limit) break; } }
    return n;
  };
  cmds.smove = (srv, c, a) => { if (a.length !== 4) throw H.WArity('smove'); const s = srv.store.get(c.db, String(a[1])); if (!s) return 0; if (s.type !== 'set') throw H.WType(); if (!s.value.has(String(a[3]))) return 0; s.value.delete(String(a[3])); const { e: d } = H.getOrCreate(srv, c, String(a[2]), 'set', () => new Set()); d.value.add(String(a[3])); srv.touchWatch(c.db, String(a[1])); srv.touchWatch(c.db, String(a[2])); return 1; };
  cmds.spop = (srv, c, a) => {
    const e = srv.store.get(c.db, String(a[1])); if (!e) return null;
    if (e.type !== 'set') throw H.WType();
    const arr = [...e.value];
    if (a[2] === undefined) { const m = arr[Math.floor(Math.random() * arr.length)]; if (m === undefined) return null; e.value.delete(m); return m; }
    const count = H.toInt(a[2], null);
    if (count === null || count < 0) throw new Error('value is not an integer or out of range');
    const out = [];
    for (let i = 0; i < Math.min(count, arr.length); i++) { const m = arr.splice(Math.floor(Math.random() * arr.length), 1)[0]; e.value.delete(m); out.push(m); }
    return out;
  };
  cmds.srandmember = (srv, c, a) => {
    const e = srv.store.get(c.db, String(a[1])); if (!e) return null;
    if (e.type !== 'set') throw H.WType();
    const arr = [...e.value];
    if (a[2] === undefined) return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
    const count = H.toInt(a[2], null);
    if (count === null) throw new Error('value is not an integer or out of range');
    if (count >= 0) { const out = []; const cp = [...arr]; for (let i = 0; i < Math.min(count, cp.length); i++) out.push(cp.splice(Math.floor(Math.random() * cp.length), 1)[0]); return out; }
    const out = []; for (let i = 0; i < -count; i++) out.push(arr[Math.floor(Math.random() * arr.length)]); return out;
  };
  cmds.sscan = (srv, c, a) => scanSet(srv, c, a, 'set');

  // ---------- sorted sets ----------
  cmds.zadd = (srv, c, a) => {
    if (a.length < 4) throw H.WArity('zadd');
    let nx = false, xx = false, gt = false, lt = false, ch = false;
    let i = 2;
    for (; i < a.length; i++) {
      const o = String(a[i]).toUpperCase();
      if (o === 'NX') nx = true; else if (o === 'XX') xx = true; else if (o === 'GT') gt = true; else if (o === 'LT') lt = true; else if (o === 'CH') ch = true; else break;
    }
    const { e } = H.getOrCreate(srv, c, String(a[1]), 'zset', newZSet);
    let added = 0, changed = 0;
    for (; i + 1 < a.length; i += 2) {
      const score = H.toFloat(a[i]); if (score === null) throw new Error('value is not a valid float');
      const m = String(a[i + 1]);
      const old = e.value.map.get(m);
      if (old !== undefined) {
        if (nx) continue;
        if ((gt && score <= old) || (lt && score >= old)) continue;
        if (score !== old) { zsetAdd(e.value, score, m); changed++; }
      } else {
        if (xx) continue;
        zsetAdd(e.value, score, m); added++; changed++;
      }
    }
    if (i < a.length) throw new Error('syntax error'); // lone score without member
    srv.touchWatch(c.db, String(a[1]));
    srv.afterListPush(c.db, String(a[1])); // wake BZPOPMIN/BZPOPMAX waiters
    return ch ? added + changed : added;
  };
  cmds.zscore = (srv, c, a) => { const e = srv.store.get(c.db, String(a[1])); if (!e) return null; if (e.type !== 'zset') throw H.WType(); const s = e.value.map.get(String(a[2])); return s === undefined ? null : trimNum(s); };
  cmds.zmscore = (srv, c, a) => { if (a.length < 3) throw H.WArity('zmscore'); const e = srv.store.get(c.db, String(a[1])); return a.slice(2).map(m => { if (!e) return null; if (e.type !== 'zset') throw H.WType(); const s = e.value.map.get(String(m)); return s === undefined ? null : trimNum(s); }); };
  cmds.zrank = (srv, c, a) => zrank(srv, c, a, false);
  cmds.zrevrank = (srv, c, a) => zrank(srv, c, a, true);
  cmds.zcard = (srv, c, a) => { const e = srv.store.get(c.db, String(a[1])); if (!e) return 0; if (e.type !== 'zset') throw H.WType(); return e.value.map.size; };
  cmds.zcount = (srv, c, a) => { if (a.length !== 4) throw H.WArity('zcount'); const e = srv.store.get(c.db, String(a[1])); if (!e) return 0; if (e.type !== 'zset') throw H.WType(); const [mn, mx] = [parseZBound(a[2]), parseZBound(a[3])]; return e.value.sorted.filter(x => cmpScore(x.s, mn) && cmpScore2(x.s, mx)).length; };
  cmds.zrange = (srv, c, a) => zrangeGeneric(srv, c, a, false);
  cmds.zrevrange = (srv, c, a) => {
    if (a.length < 4) throw H.WArity('zrevrange');
    const e = srv.store.get(c.db, String(a[1])); if (!e) return [];
    if (e.type !== 'zset') throw H.WType();
    let st = H.toInt(a[2], 0), en = H.toInt(a[3], -1);
    const arr = [...e.value.sorted].reverse();
    const n = arr.length;
    if (st < 0) st += n; if (en < 0) en += n;
    st = Math.max(0, st); en = Math.min(n - 1, en);
    let slice = st > en ? [] : arr.slice(st, en + 1);
    if (a[4] && String(a[4]).toUpperCase() === 'WITHSCORES') { const out = []; for (const x of slice) out.push(x.m, trimNum(x.s)); return out; }
    return slice.map(x => x.m);
  };
  cmds.zrangebyscore = (srv, c, a) => {
    if (a.length < 4) throw H.WArity('zrangebyscore');
    const e = srv.store.get(c.db, String(a[1])); if (!e) return [];
    if (e.type !== 'zset') throw H.WType();
    const [mn, mx] = [parseZBound(a[2]), parseZBound(a[3])];
    let items = e.value.sorted.filter(x => cmpScore(x.s, mn) && cmpScore2(x.s, mx));
    let withs = false, limit = null;
    for (let i = 4; i < a.length; i++) { const o = String(a[i]).toUpperCase(); if (o === 'WITHSCORES') withs = true; else if (o === 'LIMIT' && i + 2 < a.length) { limit = [Number(a[++i]), Number(a[++i])]; } }
    if (limit) items = items.slice(limit[0] < 0 ? 0 : limit[0], limit[0] + limit[1]);
    if (withs) { const out = []; for (const x of items) out.push(x.m, trimNum(x.s)); return out; }
    return items.map(x => x.m);
  };
  cmds.zrevrangebyscore = (srv, c, a) => {
    // ZREVRANGEBYSCORE key max min [WITHSCORES] [LIMIT off cnt] — mirror of ZRANGEBYSCORE in descending order
    if (a.length < 4) throw H.WArity('zrevrangebyscore');
    const e = srv.store.get(c.db, String(a[1])); if (!e) return [];
    if (e.type !== 'zset') throw H.WType();
    const [mx, mn] = [parseZBound(a[2]), parseZBound(a[3])]; // note: max first
    let items = e.value.sorted.filter(x => cmpScore(x.s, mn) && cmpScore2(x.s, mx)).reverse();
    let withs = false, limit = null;
    for (let i = 4; i < a.length; i++) { const o = String(a[i]).toUpperCase(); if (o === 'WITHSCORES') withs = true; else if (o === 'LIMIT' && i + 2 < a.length) { limit = [Number(a[++i]), Number(a[++i])]; } }
    if (limit) items = items.slice(limit[0] < 0 ? 0 : limit[0], (limit[0] < 0 ? 0 : limit[0]) + limit[1]);
    if (withs) { const out = []; for (const x of items) out.push(x.m, trimNum(x.s)); return out; }
    return items.map(x => x.m);
  };
  cmds.zrangebylex = (srv, c, a) => {
    if (a.length < 4) throw H.WArity('zrangebylex');
    const e = srv.store.get(c.db, String(a[1])); if (!e) return [];
    if (e.type !== 'zset') throw H.WType();
    const mn = String(a[2]), mx = String(a[3]);
    let items = e.value.sorted.map(x => x.m).sort();
    items = items.filter(m => lexCmp(mn, m) && lexCmp2(m, mx));
    let limit = null;
    for (let i = 4; i < a.length; i++) if (String(a[i]).toUpperCase() === 'LIMIT' && i + 2 < a.length) limit = [Number(a[++i]), Number(a[++i])];
    if (limit) items = items.slice(limit[0], limit[0] + limit[1]);
    return items;
  };
  cmds.zrem = (srv, c, a) => { if (a.length < 3) throw H.WArity('zrem'); const e = srv.store.get(c.db, String(a[1])); if (!e) return 0; if (e.type !== 'zset') throw H.WType(); let n = 0; for (let i = 2; i < a.length; i++) { const m = String(a[i]); if (e.value.map.delete(m)) { n++; e.value.sorted = e.value.sorted.filter(x => x.m !== m); } } if (!e.value.map.size) srv.store.del(c.db, String(a[1])); else srv.touchWatch(c.db, String(a[1])); return n; };
  cmds.zincrby = (srv, c, a) => { if (a.length !== 4) throw H.WArity('zincrby'); const d = H.toFloat(a[2]); if (d === null) throw new Error('value is not a valid float'); const { e } = H.getOrCreate(srv, c, String(a[1]), 'zset', newZSet); const old = e.value.map.get(String(a[3])) || 0; const nv = old + d; zsetAdd(e.value, nv, String(a[3])); srv.touchWatch(c.db, String(a[1])); srv.afterListPush(c.db, String(a[1])); return trimNum(nv); };
  cmds.zpopmin = (srv, c, a) => zpop(srv, c, a, 'min');
  cmds.zpopmax = (srv, c, a) => zpop(srv, c, a, 'max');
  cmds.zremrangebyscore = (srv, c, a) => { if (a.length !== 4) throw H.WArity('zremrangebyscore'); const e = srv.store.get(c.db, String(a[1])); if (!e) return 0; if (e.type !== 'zset') throw H.WType(); const [mn, mx] = [parseZBound(a[2]), parseZBound(a[3])]; const kill = e.value.sorted.filter(x => cmpScore(x.s, mn) && cmpScore2(x.s, mx)); for (const x of kill) e.value.map.delete(x.m); e.value.sorted = e.value.sorted.filter(x => !(cmpScore(x.s, mn) && cmpScore2(x.s, mx))); return kill.length; };
  cmds.zremrangebyrank = (srv, c, a) => { if (a.length !== 4) throw H.WArity('zremrangebyrank'); const e = srv.store.get(c.db, String(a[1])); if (!e) return 0; if (e.type !== 'zset') throw H.WType(); let st = H.toInt(a[2], 0), en = H.toInt(a[3], -1); const n = e.value.sorted.length; if (st < 0) st += n; if (en < 0) en += n; const kill = e.value.sorted.slice(Math.max(0, st), en + 1); for (const x of kill) e.value.map.delete(x.m); e.value.sorted = e.value.sorted.filter(x => !kill.includes(x)); return kill.length; };
  cmds.zremrangebylex = (srv, c, a) => { if (a.length !== 4) throw H.WArity('zremrangebylex'); const e = srv.store.get(c.db, String(a[1])); if (!e) return 0; if (e.type !== 'zset') throw H.WType(); const mn = String(a[2]), mx = String(a[3]); const keep = []; let rem = 0; for (const x of e.value.sorted) { if (lexCmp(mn, x.m) && lexCmp2(x.m, mx)) { e.value.map.delete(x.m); rem++; } else keep.push(x); } e.value.sorted = keep; return rem; };
  cmds.zunionstore = (srv, c, a) => zstoreOp(srv, c, a, 'union');
  cmds.zinterstore = (srv, c, a) => zstoreOp(srv, c, a, 'inter');
  cmds.zdiffstore = (srv, c, a) => zstoreOp(srv, c, a, 'diff');
  cmds.zunion = (srv, c, a) => zsetOpRead(srv, c, a, 'union');
  cmds.zinter = (srv, c, a) => zsetOpRead(srv, c, a, 'inter');
  cmds.zdiff = (srv, c, a) => zsetOpRead(srv, c, a, 'diff');
  cmds.zrandmember = (srv, c, a) => {
    const e = srv.store.get(c.db, String(a[1])); if (!e) return null;
    if (e.type !== 'zset') throw H.WType();
    const arr = e.value.sorted; if (!arr.length) return null;
    const withs = a.some(x => String(x).toUpperCase() === 'WITHSCORES');
    if (a[2] === undefined) { const x = arr[Math.floor(Math.random() * arr.length)]; return withs ? [x.m, trimNum(x.s)] : x.m; }
    const count = H.toInt(a[2], null);
    if (count === null) throw new Error('value is not an integer or out of range');
    if (count >= 0) {
      // positive count: distinct members (like SRANDMEMBER)
      const cp = [...arr];
      for (let i = cp.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[cp[i], cp[j]] = [cp[j], cp[i]]; }
      const out = [];
      for (let i = 0; i < Math.min(count, cp.length); i++) { out.push(cp[i].m); if (withs) out.push(trimNum(cp[i].s)); }
      return out;
    }
    const out = []; for (let i = 0; i < -count; i++) { const x = arr[Math.floor(Math.random() * arr.length)]; out.push(x.m); if (withs) out.push(trimNum(x.s)); } return out;
  };
  cmds.zscan = (srv, c, a) => scanSet(srv, c, a, 'zset');
  cmds.bzpopmin = (srv, c, a, send) => bzpop(srv, c, a, send, 'min');
  cmds.bzpopmax = (srv, c, a, send) => bzpop(srv, c, a, send, 'max');

  // ---------- bitmaps ----------
  cmds.setbit = (srv, c, a) => {
    if (a.length !== 4) throw H.WArity('setbit');
    const off = H.toInt(a[2]); const v = H.toInt(a[3]);
    if (off === null || off < 0 || off > 4294967295) throw new Error('bit offset is not an integer or out of range');
    if (v !== 0 && v !== 1) throw new Error('bit is not an integer or out of range');
    const { e } = H.getOrCreate(srv, c, String(a[1]), 'string', () => '');
    const buf = Buffer.from(String(e.value), 'binary');
    const idx = Math.floor(off / 8); const bit = 7 - (off % 8);
    let arr = [...buf];
    while (arr.length <= idx) arr.push(0);
    const old = (arr[idx] >> bit) & 1;
    if (v) arr[idx] |= (1 << bit); else arr[idx] &= ~(1 << bit);
    e.value = Buffer.from(arr).toString('binary');
    return old;
  };
  cmds.getbit = (srv, c, a) => {
    if (a.length !== 3) throw H.WArity('getbit');
    const off = H.toInt(a[2]); if (off === null || off < 0) throw new Error('bit offset is not an integer or out of range');
    const e = srv.store.get(c.db, String(a[1])); if (!e) return 0;
    if (e.type !== 'string') throw H.WType();
    const buf = Buffer.from(String(e.value), 'binary');
    const idx = Math.floor(off / 8); const bit = 7 - (off % 8);
    if (idx >= buf.length) return 0;
    return (buf[idx] >> bit) & 1;
  };
  cmds.bitcount = (srv, c, a) => {
    if (a.length < 2) throw H.WArity('bitcount');
    const e = srv.store.get(c.db, String(a[1])); if (!e) return 0;
    if (e.type !== 'string') throw H.WType();
    const buf = Buffer.from(String(e.value), 'binary');
    let st = 0, en = buf.length - 1, bitMode = false;
    if (a[2] !== undefined) {
      st = H.toInt(a[2], 0); en = H.toInt(a[3] ?? -1, -1);
      if (a[4] && String(a[4]).toUpperCase() === 'BIT') bitMode = true;
    }
    if (bitMode) {
      let cnt = 0;
      const total = buf.length * 8;
      let s = st < 0 ? total + st : st, ee = en < 0 ? total + en : en;
      s = Math.max(0, s); ee = Math.min(total - 1, ee);
      for (let i = s; i <= ee; i++) { const idx = Math.floor(i / 8), bit = 7 - (i % 8); if ((buf[idx] >> bit) & 1) cnt++; }
      return cnt;
    }
    if (st < 0) st += buf.length; if (en < 0) en += buf.length;
    st = Math.max(0, st); en = Math.min(buf.length - 1, en);
    if (st > en) return 0;
    let cnt = 0;
    for (let i = st; i <= en; i++) { let b = buf[i]; while (b) { cnt += b & 1; b >>= 1; } }
    return cnt;
  };
  cmds.bitop = (srv, c, a) => {
    if (a.length < 4) throw H.WArity('bitop');
    const op = String(a[1]).toUpperCase(); const dest = String(a[2]);
    if (!['AND', 'OR', 'XOR', 'NOT'].includes(op)) throw new Error('syntax error');
    const bufs = a.slice(3).map(k => { const e = srv.store.get(c.db, String(k)); if (!e) return Buffer.alloc(0); if (e.type !== 'string') throw H.WType(); return Buffer.from(String(e.value), 'binary'); });
    const maxLen = Math.max(0, ...bufs.map(b => b.length));
    const out = Buffer.alloc(maxLen);
    if (op === 'NOT') {
      if (bufs.length !== 1) throw new Error('BITOP NOT must be called with a single source key.');
      for (let i = 0; i < maxLen; i++) out[i] = ~bufs[0][i % bufs[0].length || 0] & 0xff;
    } else {
      for (let i = 0; i < maxLen; i++) {
        let v = op === 'AND' ? 0xff : 0x00;
        for (const b of bufs) { const byte = i < b.length ? b[i] : 0; if (op === 'AND') v &= byte; else if (op === 'OR') v |= byte; else if (op === 'XOR') v ^= byte; }
        out[i] = v;
      }
    }
    srv.store.set(c.db, dest, 'string', out.toString('binary'));
    return maxLen;
  };
  cmds.bitpos = (srv, c, a) => {
    if (a.length < 3) throw H.WArity('bitpos');
    const bit = H.toInt(a[2]); if (bit !== 0 && bit !== 1) throw new Error('The bit argument must be 1 or 0.');
    const e = srv.store.get(c.db, String(a[1]));
    const buf = e ? Buffer.from(String(e.value), 'binary') : Buffer.alloc(0);
    let st = a[3] !== undefined ? H.toInt(a[3], 0) : 0, en = a[4] !== undefined ? H.toInt(a[4], -1) : -1;
    let bitMode = a[5] && String(a[5]).toUpperCase() === 'BIT';
    if (bitMode) {
      const total = buf.length * 8;
      let s = st < 0 ? total + st : st, ee = en < 0 ? total + en : en;
      for (let i = s; i <= ee; i++) { const idx = Math.floor(i / 8), b = 7 - (i % 8); const v = idx < buf.length ? (buf[idx] >> b) & 1 : 0; if (v === bit) return i; }
      return -1;
    }
    if (st < 0) st += buf.length; if (en < 0) en += buf.length;
    st = Math.max(0, st); en = en === -1 && a[4] === undefined ? buf.length - 1 : Math.min(buf.length - 1, en);
    for (let i = st; i <= en; i++) for (let b = 7; b >= 0; b--) { if (((buf[i] >> b) & 1) === bit) return i * 8 + (7 - b); }
    return bit === 1 ? -1 : (en + 1) * 8;
  };
  cmds.bitfield = (srv, c, a) => {
    if (a.length < 2) throw H.WArity('bitfield');
    const { e } = H.getOrCreate(srv, c, String(a[1]), 'string', () => '');
    let buf = Buffer.from(String(e.value), 'binary');
    const out = [];
    let overflow = 'WRAP';
    for (let i = 2; i < a.length; i++) {
      const op = String(a[i]).toUpperCase();
      if (op === 'OVERFLOW' && i + 1 < a.length) { overflow = String(a[++i]).toUpperCase(); }
      else if ((op === 'GET' || op === 'SET' || op === 'INCRBY') && i + 2 < a.length) {
        const enc = String(a[++i]); const off = H.toInt(a[++i], 0);
        const m = /^([ui])(\d+)$/.exec(enc.toLowerCase());
        if (!m) throw new Error('Invalid bitfield type. Use something like i8 u8.');
        const bits = Number(m[2]);
        const need = Math.ceil((off + bits) / 8);
        while (buf.length < need) buf = Buffer.concat([buf, Buffer.alloc(need - buf.length)]);
        const readVal = () => {
          let v = 0n;
          for (let b = 0; b < bits; b++) { const pos = off + b; const idx = Math.floor(pos / 8), bt = 7 - (pos % 8); v = (v << 1n) | BigInt((buf[idx] >> bt) & 1); }
          if (m[1] === 'i' && (v >> BigInt(bits - 1)) & 1n) v -= (1n << BigInt(bits));
          return v;
        };
        const writeVal = (v) => {
          const max = 1n << BigInt(bits);
          let uv = v;
          if (overflow === 'WRAP') uv = ((v % max) + max) % max;
          else if (overflow === 'SAT') { const lo = m[1] === 'i' ? -(1n << BigInt(bits - 1)) : 0n; const hi = m[1] === 'i' ? (1n << BigInt(bits - 1)) - 1n : max - 1n; if (v < lo) uv = lo; if (v > hi) uv = hi; }
          else if (overflow === 'FAIL' && (v < 0 || v >= max)) return null;
          for (let b = bits - 1; b >= 0; b--) { const pos = off + b; const idx = Math.floor(pos / 8), bt = 7 - (pos % 8); const bit = Number((uv >> BigInt(bits - 1 - b)) & 1n); if (bit) buf[idx] |= (1 << bt); else buf[idx] &= ~(1 << bt); }
          return uv;
        };
        if (op === 'GET') out.push(Number(readVal()));
        else if (op === 'SET' && i + 1 < a.length) { const nv = BigInt(a[++i]); const old = readVal(); writeVal(nv); out.push(Number(old)); }
        else if (op === 'INCRBY' && i + 1 < a.length) { const d = BigInt(a[++i]); const old = readVal(); const r = writeVal(old + d); out.push(r === null ? null : Number(r)); }
      }
    }
    e.value = buf.toString('binary');
    return out;
  };

  // ---------- HLL (exact via Set under the hood) ----------
  cmds.pfadd = (srv, c, a) => { if (a.length < 2) throw H.WArity('pfadd'); const { e, created } = H.getOrCreate(srv, c, String(a[1]), 'set', () => new Set()); let ch = 0; for (let i = 2; i < a.length; i++) if (!e.value.has(String(a[i]))) { e.value.add(String(a[i])); ch = 1; } e._hll = true; return created ? 1 : ch; };
  cmds.pfcount = (srv, c, a) => { if (a.length < 2) throw H.WArity('pfcount'); const u = new Set(); for (let i = 1; i < a.length; i++) { const e = srv.store.get(c.db, String(a[i])); if (e) { if (e.type !== 'set') throw H.WType(); for (const m of e.value) u.add(m); } } return u.size; };
  cmds.pfmerge = (srv, c, a) => { if (a.length < 3) throw H.WArity('pfmerge'); const { e } = H.getOrCreate(srv, c, String(a[1]), 'set', () => new Set()); for (let i = 2; i < a.length; i++) { const s = srv.store.get(c.db, String(a[i])); if (s) { if (s.type !== 'set') throw H.WType(); for (const m of s.value) e.value.add(m); } } return { __resp: '+OK\r\n' }; };

  // ---------- geo ----------
  cmds.geoadd = (srv, c, a) => {
    if (a.length < 5 || (a.length - 2) % 3 !== 0) throw H.WArity('geoadd');
    const { e } = H.getOrCreate(srv, c, String(a[1]), 'zset', newZSet);
    if (!e.geo) e.geo = new Map();
    let added = 0;
    for (let i = 2; i < a.length; i += 3) {
      const lon = Number(a[i]), lat = Number(a[i + 1]), m = String(a[i + 2]);
      if (Math.abs(lon) > 180 || Math.abs(lat) > 85.051) throw new Error('invalid longitude/latitude');
      if (!e.value.map.has(m)) added++;
      // score = fake geohash int for ordering compat
      zsetAdd(e.value, lon + lat, m);
      e.geo.set(m, { lon, lat });
    }
    return added;
  };
  cmds.geodist = (srv, c, a) => {
    if (a.length < 4) throw H.WArity('geodist');
    const e = srv.store.get(c.db, String(a[1])); if (!e || !e.geo) return null;
    const p1 = e.geo.get(String(a[2])), p2 = e.geo.get(String(a[3]));
    if (!p1 || !p2) return null;
    const m = H.haversineM(p1.lon, p1.lat, p2.lon, p2.lat);
    const unit = (a[4] || 'm').toLowerCase();
    const v = unit === 'km' ? m / 1000 : unit === 'mi' ? m / 1609.344 : unit === 'ft' ? m / 0.3048 : m;
    return String(v.toFixed(4));
  };
  cmds.geopos = (srv, c, a) => {
    if (a.length < 3) throw H.WArity('geopos');
    const e = srv.store.get(c.db, String(a[1]));
    return a.slice(2).map(m => { const p = e?.geo?.get(String(m)); return p ? [String(p.lon), String(p.lat)] : null; });
  };
  cmds.geohash = (srv, c, a) => {
    if (a.length < 3) throw H.WArity('geohash');
    const e = srv.store.get(c.db, String(a[1]));
    return a.slice(2).map(m => { const p = e?.geo?.get(String(m)); return p ? H.geoHashEncode(p.lat, p.lon) : null; });
  };
  cmds.geosearch = (srv, c, a) => geoSearch(srv, c, a);
  cmds.georadius = (srv, c, a) => {
    // GEORADIUS key lon lat radius m|km|mi|ft [WITHDIST WITHCOORD] [COUNT n] [ASC|DESC] [STORE dst | STOREDIST dst]
    if (a.length < 6) throw H.WArity('georadius');
    const [key, lon, lat, r, unit] = [String(a[1]), Number(a[2]), Number(a[3]), Number(a[4]), String(a[5])];
    if (![lon, lat, r].every(Number.isFinite)) throw new Error('value is not a valid float');
    const extra = ['FROMLONLAT', lon, lat, 'BYRADIUS', r, unit, ...a.slice(6).map(String)];
    return geoSearch(srv, c, [a[0], key, ...extra]);
  };

  // ---------- streams ----------
  cmds.xadd = (srv, c, a) => {
    if (a.length < 4) throw H.WArity('xadd');
    const key = String(a[1]);
    let i = 2, maxlen = null;
    if (String(a[i]).toUpperCase() === 'MAXLEN') { i++; if (String(a[i]).toUpperCase() === '~' || String(a[i]).toUpperCase() === '=') i++; maxlen = H.toInt(a[i++]); }
    let id = String(a[i++]);
    const { e } = H.getOrCreate(srv, c, key, 'stream', () => ({ entries: [], lastId: '0-0', groups: {} }));
    if (id === '*') id = H.nextStreamId(e.value.lastId);
    else {
      if (!/^\d+-\d+$/.test(id)) throw new Error('Invalid stream ID specified as stream command argument');
      if (H.streamIdCompare(id, e.value.lastId) <= 0 && id !== '0-0') throw new Error('The ID specified in XADD is equal or smaller than the target stream top item');
    }
    const fields = {};
    for (; i + 1 < a.length; i += 2) fields[String(a[i])] = String(a[i + 1]);
    e.value.entries.push({ id, fields });
    e.value.lastId = id;
    if (maxlen !== null) while (e.value.entries.length > maxlen) e.value.entries.shift();
    srv.afterStreamAdd(c.db, key, id);
    srv.touchWatch(c.db, key);
    return id;
  };
  cmds.xlen = (srv, c, a) => { const e = srv.store.get(c.db, String(a[1])); if (!e) return 0; if (e.type !== 'stream') throw H.WType(); return e.value.entries.length; };
  cmds.xrange = (srv, c, a) => {
    if (a.length < 4) throw H.WArity('xrange');
    const e = srv.store.get(c.db, String(a[1])); if (!e) return [];
    if (e.type !== 'stream') throw H.WType();
    const [start, end] = [String(a[2]), String(a[3])];
    let count = Infinity;
    for (let i = 4; i < a.length; i++) if (String(a[i]).toUpperCase() === 'COUNT' && i + 1 < a.length) count = H.toInt(a[++i], Infinity);
    const out = [];
    for (const en of e.value.entries) {
      if ((start !== '-' && H.streamIdCompare(en.id, start) < 0) || (end !== '+' && H.streamIdCompare(en.id, end) > 0)) continue;
      out.push([en.id, Object.entries(en.fields).flat()]);
      if (out.length >= count) break;
    }
    return out;
  };
  cmds.xrevrange = (srv, c, a) => {
    if (a.length < 4) throw H.WArity('xrevrange');
    const r = cmds.xrange(srv, c, [a[0], a[1], a[3] === '+' ? '-' : a[3], a[2] === '-' ? '+' : a[2], ...a.slice(4)]);
    return r.reverse();
  };
  cmds.xtrim = (srv, c, a) => {
    if (a.length < 4) throw H.WArity('xtrim');
    const e = srv.store.get(c.db, String(a[1])); if (!e) return 0;
    if (e.type !== 'stream') throw H.WType();
    let maxlen = null, found = false;
    for (let i = 2; i < a.length; i++) {
      if (String(a[i]).toUpperCase() === 'MAXLEN') {
        found = true; i++;
        if (a[i] === '~' || a[i] === '=') i++;
        maxlen = H.toInt(a[i], null);
        if (maxlen === null || maxlen < 0) throw new Error('value is not an integer or out of range');
      } else throw new Error('syntax error');
    }
    if (!found) throw new Error('syntax error');
    let rem = 0;
    while (e.value.entries.length > maxlen) { e.value.entries.shift(); rem++; }
    return rem;
  };
  cmds.xdel = (srv, c, a) => { if (a.length < 3) throw H.WArity('xdel'); const e = srv.store.get(c.db, String(a[1])); if (!e) return 0; if (e.type !== 'stream') throw H.WType(); let n = 0; for (let i = 2; i < a.length; i++) { const idx = e.value.entries.findIndex(x => x.id === String(a[i])); if (idx >= 0) { e.value.entries.splice(idx, 1); n++; } } return n; };
  cmds.xread = (srv, c, a, send) => {
    let count = null, block = null, i = 1, sawStreams = false;
    for (; i < a.length; i++) {
      const o = String(a[i]).toUpperCase();
      if (o === 'COUNT' && i + 1 < a.length) { count = H.toInt(a[++i], null); if (count === null || count < 1) throw new Error('value is not an integer or out of range'); }
      else if (o === 'BLOCK' && i + 1 < a.length) { block = Number(a[++i]); if (!Number.isFinite(block) || block < 0) throw new Error('timeout is not an integer or out of range'); }
      else if (o === 'STREAMS') { sawStreams = true; i++; break; }
      else throw new Error('syntax error');
    }
    if (!sawStreams) throw new Error('syntax error');
    const rest = a.slice(i);
    if (rest.length < 2 || rest.length % 2 !== 0) throw new Error('syntax error: unpaired STREAMS keys and IDs');
    const nkeys = rest.length / 2;
    const keys = rest.slice(0, nkeys).map(String);
    const ids = rest.slice(nkeys).map(String);
    const readOnce = () => {
      const out = [];
      for (let k = 0; k < keys.length; k++) {
        const e = srv.store.get(c.db, keys[k]);
        if (!e || e.type !== 'stream') continue;
        let last = ids[k];
        if (last === '$') last = e.value.lastId;
        const ents = e.value.entries.filter(en => H.streamIdCompare(en.id, last) > 0).slice(0, count || undefined);
        if (ents.length) out.push([keys[k], ents.map(en => [en.id, Object.entries(en.fields).flat()])]);
      }
      return out.length ? out : null;
    };
    const data = readOnce();
    if (data || block === null) return data;
    if (block === 0) {
      srv.waitForKey(c, keys, 0, () => send(readOnce()));
      return H.DIRECT;
    }
    srv.waitForKey(c, keys, block, () => send(readOnce()));
    return H.DIRECT;
  };
  cmds.xgroup = (srv, c, a) => {
    const sub = String(a[1] || '').toUpperCase();
    if (sub === 'CREATE') {
      if (a.length < 5) throw H.WArity('xgroup');
      const e = srv.store.get(c.db, String(a[2])); if (!e || e.type !== 'stream') throw new Error('no such key');
      const g = String(a[3]); const id = String(a[4]);
      e.value.groups = e.value.groups || {};
      // real syntax: CREATE key group id|$ [MKSTREAM] — MKSTREAM sits at a[5]
      if (e.value.groups[g]) throw new Error('BUSYGROUP Consumer Group name already exists');
      e.value.groups[g] = { lastId: id === '$' ? e.value.lastId : id, pending: {}, consumers: {} };
      return { __resp: '+OK\r\n' };
    }
    if (sub === 'SETID') { const e = srv.store.get(c.db, String(a[2])); e.value.groups[String(a[3])].lastId = String(a[4]); return { __resp: '+OK\r\n' }; }
    if (sub === 'DESTROY') { const e = srv.store.get(c.db, String(a[2])); const ok = e?.value.groups?.[String(a[3])] ? 1 : 0; if (ok) delete e.value.groups[String(a[3])]; return ok; }
    if (sub === 'CREATECONSUMER' || sub === 'DELCONSUMER') return 1;
    throw H.Syntax();
  };
  cmds.xreadgroup = (srv, c, a, send) => {
    // XREADGROUP GROUP g consumer [COUNT n] [BLOCK ms] STREAMS key id
    const gi = a.findIndex(x => String(x).toUpperCase() === 'GROUP');
    const si = a.findIndex(x => String(x).toUpperCase() === 'STREAMS');
    if (gi === -1 || si === -1 || si <= gi + 3) throw new Error('syntax error');
    const [g, consumer] = [String(a[gi + 1]), String(a[gi + 2])];
    let count = null, block = null;
    for (let i = gi + 3; i < si; i++) {
      const o = String(a[i]).toUpperCase();
      if (o === 'COUNT' && i + 1 < si) { count = H.toInt(a[++i], null); if (count === null || count < 1) throw new Error('value is not an integer or out of range'); }
      else if (o === 'BLOCK' && i + 1 < si) { block = Number(a[++i]); if (!Number.isFinite(block) || block < 0) throw new Error('timeout is not an integer or out of range'); }
      else throw new Error('syntax error');
    }
    const keys = [], ids = [];
    const rest = a.slice(si + 1);
    if (rest.length < 2 || rest.length % 2 !== 0) throw new Error('syntax error: unpaired STREAMS keys and IDs');
    for (let i = 0; i < rest.length / 2; i++) keys.push(String(rest[i]));
    for (let i = rest.length / 2; i < rest.length; i++) ids.push(String(rest[i]));
    const doRead = () => {
      const out = [];
      for (let k = 0; k < keys.length; k++) {
        const e = srv.store.get(c.db, keys[k]); if (!e || e.type !== 'stream') continue;
        const grp = e.value.groups?.[g]; if (!grp) throw new Error('NOGROUP No such key or consumer group');
        let from = ids[k] === '>' ? grp.lastId : ids[k];
        const ents = e.value.entries.filter(en => H.streamIdCompare(en.id, from) > 0).slice(0, count || 10);
        if (ents.length) {
          for (const en of ents) { grp.pending[en.id] = { consumer, ts: Date.now(), deliveries: 1 }; grp.lastId = en.id; }
          out.push([keys[k], ents.map(en => [en.id, Object.entries(en.fields).flat()])]);
        }
      }
      return out.length ? out : null;
    };
    const data = doRead();
    if (data || block == null) return data;
    srv.waitForKey(c, keys, block, () => send(doRead()));
    return H.DIRECT;
  };
  cmds.xack = (srv, c, a) => { if (a.length < 4) throw H.WArity('xack'); const e = srv.store.get(c.db, String(a[1])); if (!e) return 0; const grp = e.value.groups?.[String(a[2])]; if (!grp) return 0; let n = 0; for (let i = 3; i < a.length; i++) if (grp.pending[String(a[i])]) { delete grp.pending[String(a[i])]; n++; } return n; };
  cmds.xpending = (srv, c, a) => {
    const e = srv.store.get(c.db, String(a[1])); if (!e) return [[0, null, null, null], []];
    const grp = e.value.groups?.[String(a[2])]; if (!grp) throw new Error('NOGROUP');
    const ids = Object.keys(grp.pending).sort(H.streamIdCompare);
    if (a.length === 3) return [ids.length, ids[0] || null, ids[ids.length - 1] || null, [[ids.length ? 'consumer' : null, String(ids.length)]]];
    return ids.slice(0, H.toInt(a[5] ?? a[4] ?? 10, 10)).map(id => [id, 'consumer', Date.now() - grp.pending[id].ts, grp.pending[id].deliveries]);
  };
  cmds.xinfo = (srv, c, a) => {
    const sub = String(a[1] || '').toUpperCase();
    const e = srv.store.get(c.db, String(a[2] || ''));
    if (sub === 'STREAM' && e) return ['length', e.value.entries.length, 'last-generated-id', e.value.lastId, 'groups', Object.keys(e.value.groups || {}).length, 'first-entry', e.value.entries[0] ? [e.value.entries[0].id, Object.entries(e.value.entries[0].fields).flat()] : null, 'last-entry', e.value.entries.length ? [e.value.entries[e.value.entries.length - 1].id, Object.entries(e.value.entries[e.value.entries.length - 1].fields).flat()] : null];
    if (sub === 'GROUPS') return Object.entries(e?.value.groups || {}).map(([n, g]) => ['name', n, 'consumers', 1, 'pending', Object.keys(g.pending).length, 'last-delivered-id', g.lastId]);
    if (sub === 'CONSUMERS') return [];
    throw H.Syntax();
  };
  cmds.xautoclaim = (srv, c, a) => [0, '0-0', []];
  cmds.xclaim = () => [];

  // ---------- pub/sub ----------
  cmds.subscribe = (srv, c, a, send) => {
    if (a.length < 2) throw H.WArity('subscribe');
    c.subscribed = true;
    for (let i = 1; i < a.length; i++) {
      const ch = String(a[i]);
      srv.subscribe(c, ch);
      send(['subscribe', ch, c.channels.size]);
    }
    return H.DIRECT;
  };
  cmds.unsubscribe = (srv, c, a, send) => {
    const chans = a.length > 1 ? a.slice(1).map(String) : [...c.channels];
    for (const ch of chans) { srv.unsubscribe(c, ch); send(['unsubscribe', ch, c.channels.size]); }
    if (!c.channels.size && !c.patterns.size) c.subscribed = false;
    return H.DIRECT;
  };
  cmds.psubscribe = (srv, c, a, send) => {
    if (a.length < 2) throw H.WArity('psubscribe');
    c.subscribed = true;
    for (let i = 1; i < a.length; i++) { srv.psubscribe(c, String(a[i])); send(['psubscribe', String(a[i]), c.patterns.size]); }
    return H.DIRECT;
  };
  cmds.punsubscribe = (srv, c, a, send) => {
    const pats = a.length > 1 ? a.slice(1).map(String) : [...c.patterns];
    for (const p of pats) { srv.punsubscribe(c, p); send(['punsubscribe', p, c.patterns.size]); }
    if (!c.channels.size && !c.patterns.size) c.subscribed = false;
    return H.DIRECT;
  };
  cmds.publish = (srv, c, a) => {
    if (a.length !== 3) throw H.WArity('publish');
    return srv.publish(String(a[1]), String(a[2]));
  };
  cmds.pubsub = (srv, c, a) => {
    const sub = String(a[1] || '').toUpperCase();
    if (sub === 'CHANNELS') { const pat = a[2] ? String(a[2]) : '*'; const { globToRegExp } = require('./datastore'); const re = globToRegExp(pat); return [...srv.channels.keys()].filter(k => re.test(k)); }
    if (sub === 'NUMSUB') { const out = []; for (let i = 2; i < a.length; i++) out.push(String(a[i]), srv.channels.get(String(a[i]))?.size || 0); return out; }
    if (sub === 'NUMPAT') return srv.patterns.size;
    if (sub === 'SHARDCHANNELS' || sub === 'SHARDNUMSUB') return [];
    throw H.Syntax();
  };

  // ---------- scripting (JS via vm; Lua-compatible subset) ----------
  cmds.eval = (srv, c, a) => {
    if (a.length < 3) throw H.WArity('eval');
    const n = H.toInt(a[2], null);
    if (n === null || n < 0 || a.length < 3 + n) throw new Error('value is not an integer or out of range');
    return runScript(srv, c, String(a[1]), a.slice(3, 3 + n).map(String), a.slice(3 + n).map(String));
  };
  cmds.evalsha = (srv, c, a) => {
    if (a.length < 3) throw H.WArity('evalsha');
    const n = H.toInt(a[2], null);
    if (n === null || n < 0 || a.length < 3 + n) throw new Error('value is not an integer or out of range');
    const src = srv.scripts.get(String(a[1]).toLowerCase());
    if (!src) throw new Error('NOSCRIPT No matching script. Please use EVAL.');
    return runScript(srv, c, src, a.slice(3, 3 + n).map(String), a.slice(3 + n).map(String));
  };
  cmds.script = (srv, c, a) => {
    const sub = String(a[1] || '').toUpperCase();
    if (sub === 'LOAD') { const sha = crypto.createHash('sha1').update(String(a[2])).digest('hex'); srv.scripts.set(sha, String(a[2])); return sha; }
    if (sub === 'EXISTS') return a.slice(2).map(s => srv.scripts.has(String(s).toLowerCase()) ? 1 : 0);
    if (sub === 'FLUSH') { srv.scripts.clear(); return { __resp: '+OK\r\n' }; }
    throw H.Syntax();
  };
}

// ------- helpers -------
function setOp(srv, c, a, op, store) {
  const dest = store ? String(a[1]) : null;
  const keys = (store ? a.slice(2) : a.slice(1)).map(String);
  if (!keys.length) throw H.WArity('setop');
  const sets = keys.map(k => { const e = srv.store.get(c.db, k); if (!e) return new Set(); if (e.type !== 'set') throw H.WType(); return e.value; });
  let res;
  if (op === 'union') { res = new Set(); for (const s of sets) for (const m of s) res.add(m); }
  else if (op === 'inter') { res = new Set(sets[0]); for (const s of sets.slice(1)) for (const m of [...res]) if (!s.has(m)) res.delete(m); }
  else { res = new Set(sets[0]); for (const s of sets.slice(1)) for (const m of [...res]) if (s.has(m)) res.delete(m); }
  if (store) { if (res.size) srv.store.set(c.db, dest, 'set', res); else srv.store.del(c.db, dest); return res.size; }
  return [...res];
}
function scanSet(srv, c, a, kind) {
  // SSCAN key cursor / ZSCAN key cursor
  if (a.length < 3) throw H.WArity(kind === 'zset' ? 'zscan' : 'sscan');
  const { globToRegExp } = require('./datastore');
  const key = String(a[1]);
  let cursor = H.toInt(a[2], 0), match = '*', count = 10;
  for (let i = 3; i < a.length; i++) { const o = String(a[i]).toUpperCase(); if (o === 'MATCH' && i + 1 < a.length) match = String(a[++i]); else if (o === 'COUNT' && i + 1 < a.length) count = H.toInt(a[++i], 10); }
  const e = srv.store.get(c.db, key);
  if (!e) return ['0', []];
  if (kind === 'zset' && e.type !== 'zset') throw H.WType();
  if (kind !== 'zset' && e.type !== 'set') throw H.WType();
  const re = globToRegExp(match);
  let items = [];
  if (e.type === 'set') items = [...e.value].filter(m => re.test(m));
  else if (e.type === 'zset') { for (const { m, s } of e.value.sorted) if (re.test(m)) items.push(m, trimNum(s)); }
  const slice = items.slice(cursor, cursor + count);
  return [String(cursor + count >= items.length ? 0 : cursor + count), slice];
}
function trimNum(n) { const s = String(n); if (s.includes('.')) { const v = parseFloat(s); return String(v); } return s; }
function parseZBound(v) {
  v = String(v);
  if (v === '-inf') return { v: -Infinity, ex: false };
  if (v === '+inf') return { v: Infinity, ex: false };
  if (v.startsWith('(')) return { v: Number(v.slice(1)), ex: true };
  return { v: Number(v), ex: false };
}
function cmpScore(s, b) { return b.ex ? s > b.v : s >= b.v; }
function cmpScore2(s, b) { return b.ex ? s < b.v : s <= b.v; }
function lexCmp(min, m) { if (min === '-') return true; if (min === '+') return false; if (min.startsWith('[')) return m >= min.slice(1); if (min.startsWith('(')) return m > min.slice(1); return true; }
function lexCmp2(m, max) { if (max === '+') return true; if (max === '-') return false; if (max.startsWith('[')) return m <= max.slice(1); if (max.startsWith('(')) return m < max.slice(1); return true; }
function zrank(srv, c, a, rev) {
  const e = srv.store.get(c.db, String(a[1])); if (!e) return null;
  if (e.type !== 'zset') throw H.WType();
  const arr = rev ? [...e.value.sorted].reverse() : e.value.sorted;
  const idx = arr.findIndex(x => x.m === String(a[2]));
  if (idx === -1) return null;
  if (a[3] && String(a[3]).toUpperCase() === 'WITHSCORE') return [idx, trimNum(arr[idx].s)];
  return idx;
}
function zrangeGeneric(srv, c, a, revDefault) {
  // ZRANGE key start stop [BYSCORE|BYLEX] [REV] [LIMIT o c] [WITHSCORES]
  if (a.length < 4) throw H.WArity('zrange');
  const e = srv.store.get(c.db, String(a[1])); if (!e) return [];
  if (e.type !== 'zset') throw H.WType();
  let byscore = false, bylex = false, rev = revDefault, withs = false, limit = null;
  for (let i = 4; i < a.length; i++) {
    const o = String(a[i]).toUpperCase();
    if (o === 'BYSCORE') byscore = true; else if (o === 'BYLEX') bylex = true; else if (o === 'REV') rev = true;
    else if (o === 'WITHSCORES') withs = true;
    else if (o === 'LIMIT' && i + 2 < a.length) limit = [Number(a[++i]), Number(a[++i])];
  }
  let items;
  if (byscore) {
    const [mn, mx] = [parseZBound(a[2]), parseZBound(a[3])];
    items = e.value.sorted.filter(x => cmpScore(x.s, mn) && cmpScore2(x.s, mx));
    if (rev) items = items.reverse();
  } else if (bylex) {
    let ms = e.value.sorted.map(x => x.m).sort();
    if (rev) ms = ms.reverse();
    items = ms.filter(m => lexCmp(String(a[2]), m) && lexCmp2(m, String(a[3]))).map(m => ({ m, s: e.value.map.get(m) }));
  } else {
    let st = H.toInt(a[2], 0), en = H.toInt(a[3], -1);
    const n = e.value.sorted.length;
    if (st < 0) st += n; if (en < 0) en += n;
    st = Math.max(0, st); en = Math.min(n - 1, en);
    items = st > en ? [] : e.value.sorted.slice(st, en + 1);
    if (rev) items = items.reverse();
  }
  if (limit) items = items.slice(limit[0] < 0 ? 0 : limit[0], (limit[0] < 0 ? 0 : limit[0]) + limit[1]);
  if (withs) { const out = []; for (const x of items) out.push(x.m, trimNum(x.s)); return out; }
  return items.map(x => x.m);
}
function zpop(srv, c, a, which) {
  if (a.length < 2) throw H.WArity('zpopmin');
  const e = srv.store.get(c.db, String(a[1])); if (!e) return [];
  if (e.type !== 'zset') throw H.WType();
  const count = a[2] !== undefined ? Math.max(0, H.toInt(a[2], 1)) : 1;
  const out = [];
  for (let i = 0; i < count && e.value.sorted.length; i++) {
    const x = which === 'min' ? e.value.sorted.shift() : e.value.sorted.pop();
    e.value.map.delete(x.m); out.push(x.m, trimNum(x.s));
  }
  if (!e.value.map.size) srv.store.del(c.db, String(a[1])); else srv.touchWatch(c.db, String(a[1]));
  return a[2] === undefined ? out.slice(0, 2).length === 2 && out.length === 2 ? out : out : out;
}
function bzpop(srv, c, a, send, which) {
  if (a.length < 3) throw H.WArity('bzpopmin');
  const timeout = Number(a[a.length - 1]);
  if (!Number.isFinite(timeout) || timeout < 0) throw new Error('timeout is not an integer or out of range');
  const keys = a.slice(1, -1).map(String);
  if (!keys.length) throw H.WArity('bzpopmin');
  for (const k of keys) {
    const e = srv.store.get(c.db, k);
    if (e && e.type === 'zset' && e.value.sorted.length) {
      const x = which === 'min' ? e.value.sorted.shift() : e.value.sorted.pop();
      e.value.map.delete(x.m);
      srv.touchWatch(c.db, k);
      return [k, x.m, trimNum(x.s)];
    }
  }
  srv.waitForKey(c, keys, timeout * 1000, (key) => {
    if (key === null) { send(null); return; }
    const e = srv.store.get(c.db, key);
    if (!e || e.type !== 'zset' || !e.value.sorted.length) { send(null); return; }
    const x = which === 'min' ? e.value.sorted.shift() : e.value.sorted.pop();
    e.value.map.delete(x.m);
    srv.touchWatch(c.db, key);
    send([key, x.m, trimNum(x.s)]);
  });
  return H.DIRECT;
}
function parseZStoreArgs(a) {
  // dest numkeys key [key...] [WEIGHTS w...] [AGGREGATE SUM|MIN|MAX]
  const numkeys = H.toInt(a[2]); const keys = a.slice(3, 3 + numkeys).map(String);
  let weights = keys.map(() => 1), agg = 'sum';
  for (let i = 3 + numkeys; i < a.length; i++) {
    const o = String(a[i]).toUpperCase();
    if (o === 'WEIGHTS') { weights = []; for (let j = 0; j < numkeys; j++) weights.push(Number(a[++i])); }
    else if (o === 'AGGREGATE' && i + 1 < a.length) agg = String(a[++i]).toLowerCase();
  }
  return { dest: String(a[1]), keys, weights, agg };
}
function zstoreOp(srv, c, a, op) {
  const { dest, keys, weights, agg } = parseZStoreArgs(a);
  const map = new Map();
  const aggFn = (old, v) => old === undefined ? v : agg === 'min' ? Math.min(old, v) : agg === 'max' ? Math.max(old, v) : old + v;
  if (op === 'diff') {
    const first = srv.store.get(c.db, keys[0]);
    if (first && first.type === 'zset') for (const [m, s] of first.value.map) map.set(m, s * weights[0]);
    for (let i = 1; i < keys.length; i++) { const e = srv.store.get(c.db, keys[i]); if (e && e.type === 'zset') for (const m of e.value.map.keys()) map.delete(m); }
  } else {
    keys.forEach((k, ki) => {
      const e = srv.store.get(c.db, k);
      if (!e) return;
      if (e.type === 'zset') for (const [m, s] of e.value.map) map.set(m, aggFn(map.get(m), s * weights[ki]));
      else if (e.type === 'set' && op === 'union') for (const m of e.value) map.set(m, aggFn(map.get(m), 1 * weights[ki]));
    });
    if (op === 'inter') {
      for (const m of [...map.keys()]) {
        for (let ki = 0; ki < keys.length; ki++) {
          const e = srv.store.get(c.db, keys[ki]);
          const has = e && ((e.type === 'zset' && e.value.map.has(m)) || (e.type === 'set' && e.value.has(m)));
          if (!has) { map.delete(m); break; }
        }
      }
    }
  }
  if (!map.size) { srv.store.del(c.db, dest); return 0; }
  const z = newZSet();
  for (const [m, s] of map) zsetAdd(z, s, m);
  srv.store.set(c.db, dest, 'zset', z);
  return map.size;
}
function zsetOpRead(srv, c, a, op) {
  // ZUNION numkeys key... [WEIGHTS ...] [AGGREGATE ...] [WITHSCORES]
  const withs = a.some(x => String(x).toUpperCase() === 'WITHSCORES');
  const filtered = a.filter(x => String(x).toUpperCase() !== 'WITHSCORES');
  const tmp = ['TMP', ...filtered.slice(1)];
  // reuse zstoreOp into temp then read
  const { keys, weights, agg } = parseZStoreArgs(['_', ...filtered.slice(0)]);
  void tmp;
  const map = new Map();
  const aggFn = (old, v) => old === undefined ? v : agg === 'min' ? Math.min(old, v) : agg === 'max' ? Math.max(old, v) : old + v;
  const numkeys = H.toInt(filtered[1]);
  const ks = filtered.slice(2, 2 + numkeys).map(String);
  let wts = ks.map(() => 1), ag = 'sum';
  for (let i = 2 + numkeys; i < filtered.length; i++) {
    const o = String(filtered[i]).toUpperCase();
    if (o === 'WEIGHTS') { wts = []; for (let j = 0; j < numkeys; j++) wts.push(Number(filtered[++i])); }
    else if (o === 'AGGREGATE') ag = String(filtered[++i]).toLowerCase();
  }
  const fn = (old, v) => old === undefined ? v : ag === 'min' ? Math.min(old, v) : ag === 'max' ? Math.max(old, v) : old + v;
  if (op === 'diff') {
    const first = srv.store.get(c.db, ks[0]);
    if (first?.type === 'zset') for (const [m, s] of first.value.map) map.set(m, s * wts[0]);
    for (let i = 1; i < ks.length; i++) { const e = srv.store.get(c.db, ks[i]); if (e?.type === 'zset') for (const m of e.value.map.keys()) map.delete(m); }
  } else {
    ks.forEach((k, ki) => {
      const e = srv.store.get(c.db, k);
      if (!e) return;
      if (e.type === 'zset') for (const [m, s] of e.value.map) map.set(m, fn(map.get(m), s * wts[ki]));
    });
    if (op === 'inter') for (const m of [...map.keys()]) for (const k of ks) { const e = srv.store.get(c.db, k); if (!(e?.type === 'zset' && e.value.map.has(m))) { map.delete(m); break; } }
  }
  const arr = [...map.entries()].sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : 1));
  if (!withs) return arr.map(x => x[0]);
  const out = []; for (const [m, s] of arr) out.push(m, trimNum(s)); return out;
}
function geoSearch(srv, c, a) {
  // GEOSEARCH key <FROMMEMBER m | FROMLONLAT lon lat> <BYRADIUS r unit | BYBOX w h unit> [ASC|DESC] [COUNT [n [ANY]]|... ] [WITHDIST WITHCOORD WITHHASH]
  if (a.length < 6) throw H.WArity('geosearch');
  const key = String(a[1]);
  const e = srv.store.get(c.db, key);
  if (!e) return [];
  if (e.type !== 'zset' || !e.geo) throw H.WType();
  let lon0, lat0;
  let i = 2;
  const o1 = String(a[i]).toUpperCase();
  if (o1 === 'FROMMEMBER' && i + 1 < a.length) { const p = e.geo.get(String(a[++i])); if (!p) return []; lon0 = p.lon; lat0 = p.lat; i++; }
  else if (o1 === 'FROMLONLAT' && i + 2 < a.length) { lon0 = Number(a[++i]); lat0 = Number(a[++i]); i++; }
  else throw H.Syntax();
  let radiusM = null, boxW = null, boxH = null, distUnit = 'm';
  const o2 = String(a[i]).toUpperCase();
  if (o2 === 'BYRADIUS' && i + 2 < a.length) { distUnit = String(a[i + 2]).toLowerCase(); radiusM = H.parseDist(a[i + 1], a[i + 2]); i += 3; }
  else if (o2 === 'BYBOX' && i + 3 < a.length) { distUnit = String(a[i + 3]).toLowerCase(); boxW = H.parseDist(a[i + 1], a[i + 3]); boxH = H.parseDist(a[i + 2], a[i + 3]); i += 4; }
  else throw H.Syntax();
  let asc = true, count = null, withdist = false, withcoord = false, withhash = false;
  for (; i < a.length; i++) {
    const o = String(a[i]).toUpperCase();
    if (o === 'ASC') asc = true; else if (o === 'DESC') asc = false;
    else if (o === 'COUNT' && i + 1 < a.length) { count = H.toInt(a[++i], 10); if (a[i + 1] && String(a[i + 1]).toUpperCase() === 'ANY') i++; }
    else if (o === 'WITHDIST') withdist = true; else if (o === 'WITHCOORD') withcoord = true; else if (o === 'WITHHASH') withhash = true;
    else if (o === 'WITHDISTANCE') withdist = true;
  }
  let items = [];
  for (const [m, p] of e.geo) {
    const d = H.haversineM(lon0, lat0, p.lon, p.lat);
    let ok = false;
    if (radiusM !== null) ok = d <= radiusM;
    else { ok = Math.abs(p.lon - lon0) * 111320 <= boxW / 2 && Math.abs(p.lat - lat0) * 110540 <= boxH / 2; }
    if (ok) items.push({ m, d, p });
  }
  items.sort((x, y) => asc ? x.d - y.d : y.d - x.d);
  if (count !== null) items = items.slice(0, count);
  if (!withdist && !withcoord && !withhash) return items.map(x => x.m);
  const toUnit = (m) => {
    const v = distUnit === 'km' ? m / 1000 : distUnit === 'mi' ? m / 1609.344 : distUnit === 'ft' ? m / 0.3048 : m;
    return String(v.toFixed(4));
  };
  return items.map(x => {
    const row = [x.m];
    if (withdist) row.push(toUnit(x.d));
    if (withhash) row.push(String(hashScore(x.p.lat, x.p.lon)));
    if (withcoord) row.push([String(x.p.lon), String(x.p.lat)]);
    return row;
  });
}
function hashScore(lat, lon) { return String(Math.floor((lon + 180) * 10000) + Math.floor((lat + 90) * 10000)); }
function runScript(srv, c, src, keys, argv) {
  // Expose KEYS, ARGV, redis.call / redis.pcall. Internal reply values are
  // converted to script-visible values: {__resp:'+OK'} -> 'OK', Error throws
  // under call() (returned as ['err', msg] under pcall()).
  const toLua = (r) => {
    if (r === null || r === undefined) return null;
    if (r instanceof Error) throw r;
    if (typeof r === 'object' && r !== null && r.__resp) {
      const s = r.__resp;
      if (s.startsWith('+')) return s.slice(1, -2); // +OK -> OK
      return null;
    }
    if (Array.isArray(r)) return r.map(toLua);
    if (typeof r === 'number') return Number.isInteger(r) ? r : String(r);
    return r;
  };
  const invoke = (args) => srv.runCommand({ ...c, inMulti: null, waiters: new Set() }, args.map(String), true);
  const sandbox = {
    KEYS: keys, ARGV: argv,
    redis: {
      call: (...args) => {
        const r = invoke(args);
        if (r === H.DIRECT) throw new Error('ERR command cannot run inside a script');
        return toLua(r);
      },
      pcall: (...args) => {
        try {
          const r = invoke(args);
          if (r === H.DIRECT) return ['err', 'command cannot run inside a script'];
          return toLua(r);
        } catch (e) { return ['err', String((e && e.message) || e)]; }
      },
    },
  };
  sandbox.redis.callAsync = sandbox.redis.call;
  const ctx = vm.createContext(sandbox);
  // Wrap: allow `return redis.call(...)` style Lua-ish or plain JS last-expression
  let code = src;
  if (/return\s/.test(code) && !/function|=>|const|let|var/.test(code)) {
    // single return statement: `return redis.call('get','x')` -> `redis.call('get','x')`
    code = code.replace(/return\s+/, '');
  }
  try {
    const script = new vm.Script(code, { timeout: 2000 });
    const res = script.runInContext(ctx, { timeout: 2000 });
    return normalizeScriptResult(res);
  } catch (e) { throw new Error(String(e.message || e)); }
}
function normalizeScriptResult(res) {
  if (res === undefined) return null;
  if (typeof res === 'number') return Number.isInteger(res) ? res : String(res);
  if (typeof res === 'string' || typeof res === 'boolean') return res;
  if (Array.isArray(res)) return res.map(normalizeScriptResult);
  if (res instanceof Error) throw res;
  // converted {__resp} objects never reach here, but guard anyway
  if (res && typeof res === 'object' && res.__resp) return res.__resp.startsWith('+') ? res.__resp.slice(1, -2) : null;
  return res === null ? null : String(res);
}

module.exports = { registerAdvanced };
