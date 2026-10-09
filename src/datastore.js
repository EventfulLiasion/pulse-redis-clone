'use strict';
/**
 * Multi-DB in-memory store with types, expiry, LRU/LFU, versioning for WATCH.
 */

const NUM_DBS = 16;

class DataStore {
  constructor(opts = {}) {
    this.numDbs = opts.numDbs || NUM_DBS;
    this.dbs = Array.from({ length: this.numDbs }, () => new Map());
    this.versions = Array.from({ length: this.numDbs }, () => new Map()); // key -> version int
    this.maxmemory = opts.maxmemory || 0; // bytes, 0 = unlimited
    this.maxmemoryPolicy = opts.maxmemoryPolicy || 'noeviction';
    this.memoryUsed = 0;
    this.hz = 10;
  }

  _db(i) { return this.dbs[i] || this.dbs[0]; }

  _bump(dbIdx, key) {
    const v = this.versions[dbIdx];
    v.set(key, (v.get(key) || 0) + 1);
  }

  _isExpired(entry) {
    return entry.expireAt !== null && entry.expireAt !== undefined && Date.now() >= entry.expireAt;
  }

  /** Get entry or null (lazy expiry). */
  get(dbIdx, key) {
    const db = this._db(dbIdx);
    const e = db.get(key);
    if (!e) return null;
    if (this._isExpired(e)) {
      db.delete(key);
      this._bump(dbIdx, key);
      this.memoryUsed -= e._mem || 0;
      return null;
    }
    e.lru = Date.now();
    e.freq = (e.freq || 0) + 1;
    return e;
  }

  getEntry(dbIdx, key) { return this.get(dbIdx, key); }

  set(dbIdx, key, type, value, expireAt = null) {
    const db = this._db(dbIdx);
    const old = db.get(key);
    if (old) this.memoryUsed -= old._mem || 0; // subtract even if expired (entry is overwritten)
    if (old && this._isExpired(old)) db.delete(key);
    const mem = roughSize(value);
    const entry = { type, value, expireAt, lru: Date.now(), freq: 1, _mem: mem + key.length * 2 + 64 };
    db.set(key, entry);
    this.memoryUsed += entry._mem;
    this._bump(dbIdx, key);
    this.maybeEvict(dbIdx);
    return entry;
  }

  del(dbIdx, ...keys) {
    const db = this._db(dbIdx);
    let n = 0;
    for (const k of keys) {
      const e = this.get(dbIdx, k); // expiry-aware: expired keys count as missing
      if (e) {
        this.memoryUsed -= e._mem || 0;
        db.delete(k);
        this._bump(dbIdx, k);
        n++;
      }
    }
    return n;
  }

  exists(dbIdx, ...keys) {
    let n = 0;
    for (const k of keys) if (this.get(dbIdx, k)) n++;
    return n;
  }

  typeOf(dbIdx, key) {
    const e = this.get(dbIdx, key);
    return e ? e.type : 'none';
  }

  expire(dbIdx, key, expireAt) {
    const e = this.get(dbIdx, key);
    if (!e) return 0;
    e.expireAt = expireAt;
    this._bump(dbIdx, key);
    return 1;
  }

  ttlMs(dbIdx, key) {
    const db = this._db(dbIdx);
    const raw = db.get(key);
    if (!raw) return -2;
    if (this._isExpired(raw)) { db.delete(key); this._bump(dbIdx, key); return -2; }
    if (raw.expireAt == null) return -1;
    return Math.max(0, raw.expireAt - Date.now());
  }

  keys(dbIdx, pattern) {
    const db = this._db(dbIdx);
    const re = globToRegExp(pattern || '*');
    const out = [];
    for (const [k, e] of db) {
      if (this._isExpired(e)) { db.delete(k); continue; }
      if (re.test(k)) out.push(k);
    }
    return out;
  }

  dbsize(dbIdx) {
    const db = this._db(dbIdx);
    let n = 0;
    for (const [k, e] of db) {
      if (this._isExpired(e)) { db.delete(k); continue; }
      n++;
    }
    return n;
  }

  flushdb(dbIdx) {
    const db = this._db(dbIdx);
    for (const k of [...db.keys()]) this._bump(dbIdx, k);
    db.clear();
    this.memoryUsed = this.totalMemory();
  }

  flushall() {
    for (let i = 0; i < this.numDbs; i++) this.flushdb(i);
    this.memoryUsed = 0;
  }

  randomKey(dbIdx) {
    const ks = [...this._db(dbIdx).keys()].filter(k => !this._isExpired(this._db(dbIdx).get(k)));
    if (!ks.length) return null;
    return ks[Math.floor(Math.random() * ks.length)];
  }

  /** Active expiry: sample 20 keys per DB, delete expired. Returns expired count. */
  activeExpireCycle() {
    let expired = 0;
    for (let i = 0; i < this.numDbs; i++) {
      const db = this.dbs[i];
      if (!db.size) continue;
      const ks = [...db.keys()];
      const sample = Math.min(20, ks.length);
      for (let s = 0; s < sample; s++) {
        const k = ks[Math.floor(Math.random() * ks.length)];
        const e = db.get(k);
        if (e && this._isExpired(e)) { db.delete(k); this.memoryUsed -= e._mem || 0; this._bump(i, k); expired++; }
      }
    }
    return expired;
  }

  maybeEvict(dbIdx) {
    if (!this.maxmemory || this.memoryUsed <= this.maxmemory) return;
    if (this.maxmemoryPolicy === 'noeviction') return;
    const db = this._db(dbIdx);
    // collect candidates
    let candidates = [...db.entries()].filter(([, e]) => {
      if (this.maxmemoryPolicy.startsWith('volatile-') && e.expireAt == null) return false;
      return true;
    });
    if (!candidates.length) return;
    const evictOne = () => {
      let pick;
      if (this.maxmemoryPolicy.includes('lru')) {
        candidates.sort((a, b) => a[1].lru - b[1].lru);
        pick = candidates[0];
      } else if (this.maxmemoryPolicy.includes('lfu')) {
        candidates.sort((a, b) => (a[1].freq || 0) - (b[1].freq || 0));
        pick = candidates[0];
      } else if (this.maxmemoryPolicy.includes('ttl')) {
        candidates = candidates.filter(([, e]) => e.expireAt != null);
        if (!candidates.length) return;
        candidates.sort((a, b) => a[1].expireAt - b[1].expireAt);
        pick = candidates[0];
      } else { // random
        pick = candidates[Math.floor(Math.random() * candidates.length)];
      }
      if (pick) {
        const [k, e] = pick;
        db.delete(k); this.memoryUsed -= e._mem || 0; this._bump(dbIdx, k);
        candidates = candidates.filter(c => c[0] !== k);
      }
    };
    let guard = 0;
    while (this.memoryUsed > this.maxmemory && candidates.length && guard++ < 100) evictOne();
  }

  totalMemory() {
    let t = 0;
    for (const db of this.dbs) for (const [, e] of db) t += e._mem || 0;
    return t;
  }

  /** Snapshot all DBs to plain JSON-able object. */
  snapshot() {
    const out = { numDbs: this.numDbs, dbs: [] };
    for (let i = 0; i < this.numDbs; i++) {
      const arr = [];
      for (const [k, e] of this.dbs[i]) {
        if (this._isExpired(e)) continue;
        arr.push({ k, type: e.type, value: serializeValue(e.type, e.value, e), expireAt: e.expireAt });
      }
      out.dbs.push(arr);
    }
    return out;
  }

  restore(snap) {
    this.flushall();
    const n = Math.min(snap.numDbs || NUM_DBS, this.numDbs);
    for (let i = 0; i < n; i++) {
      for (const row of (snap.dbs[i] || [])) {
        // skip already-expired
        if (row.expireAt && Date.now() >= row.expireAt) continue;
        if (!['string', 'list', 'hash', 'set', 'zset', 'stream'].includes(row.type)) continue;
        const val = deserializeValue(row.type, row.value);
        const ent = this.set(i, row.k, row.type, val, row.expireAt ?? null);
        // geo lives at entry level (see GEOADD); reattach after set
        if (row.type === 'zset' && val && val.geo instanceof Map && val.geo.size) {
          ent.geo = val.geo;
          delete val.geo;
        }
      }
    }
    this.memoryUsed = this.totalMemory();
  }
}

function serializeValue(type, value, entry) {
  switch (type) {
    case 'string': return String(value);
    case 'list': return [...value];
    case 'hash': return [...value.entries()];
    case 'set': return [...value];
    case 'zset': return { map: [...value.map.entries()], geo: entry && entry.geo ? [...entry.geo.entries()] : undefined };
    case 'stream': return value; // { entries: [...], lastId, groups? }
    default: return value;
  }
}
function deserializeValue(type, raw) {
  switch (type) {
    case 'string': return String(raw);
    case 'list': return [...raw];
    case 'hash': return new Map(raw);
    case 'set': return new Set(raw);
    case 'zset': {
      const z = { map: new Map(raw.map || []), sorted: [] };
      z.sorted = [...z.map.entries()].map(([m, s]) => ({ m, s: Number(s) }))
        .sort((a, b) => a.s - b.s || (a.m < b.m ? -1 : 1));
      if (raw.geo) z.geo = new Map(raw.geo);
      return z;
    }
    case 'stream': return raw;
    default: return raw;
  }
}

function roughSize(v) {
  try {
    if (typeof v === 'string') return v.length * 2;
    if (Array.isArray(v)) return v.reduce((a, x) => a + String(x).length * 2, 0) + 64;
    if (v instanceof Map) { let s = 64; for (const [k, x] of v) s += String(k).length * 2 + String(x).length * 2; return s; }
    if (v instanceof Set) { let s = 64; for (const x of v) s += String(x).length * 2; return s; }
    if (v && v.map instanceof Map) { let s = 64; for (const [k, x] of v.map) s += String(k).length * 2 + 16; return s; }
    return JSON.stringify(v)?.length * 2 || 128;
  } catch { return 256; }
}

function globToRegExp(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      let j = i;
      while (j < glob.length && glob[j] !== ']') j++;
      re += glob.slice(i, j + 1);
      i = j;
    } else if ('\\^$.|+(){}'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(re + '$');
}

function newZSet() { return { map: new Map(), sorted: [] }; }
function zsetAdd(z, score, member) {
  member = String(member); score = Number(score);
  const existed = z.map.has(member);
  z.map.set(member, score);
  z.sorted = z.sorted.filter(e => e.m !== member);
  // binary insert
  let lo = 0, hi = z.sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const e = z.sorted[mid];
    if (e.s < score || (e.s === score && e.m < member)) lo = mid + 1; else hi = mid;
  }
  z.sorted.splice(lo, 0, { m: member, s: score });
  return !existed ? 1 : 0;
}

module.exports = { DataStore, newZSet, zsetAdd, globToRegExp, serializeValue, deserializeValue };
