'use strict';
const fs = require('fs');
const path = require('path');
const { encodeCommand } = require('./resp');

class Persistence {
  constructor(server, opts = {}) {
    this.server = server;
    this.dir = opts.dir || path.join(process.cwd(), 'data');
    this.aofFile = path.join(this.dir, 'appendonly.aof');
    this.rdbFile = path.join(this.dir, 'dump.rdb.json');
    this.aofEnabled = opts.aof !== false;
    this.aofFd = null;
    this.lastSave = Date.now();
    this.savepoints = opts.savepoints || [[900, 1], [300, 10], [60, 100]];
    this.dirty = 0;
    this.lastSaveTime = Date.now();
    // Surfaced (not swallowed) persistence health. See README durability notes:
    // AOF appends are write() without per-command fsync, so a crash may lose
    // the tail; RDB/rewrite files are fsync'd before rename.
    this.writeErrors = 0;
    this.lastError = null;
  }

  _recordError(where, err) {
    this.writeErrors++;
    this.lastError = `${where}: ${(err && err.message) || err} @ ${new Date().toISOString()}`;
    console.error(`[persist] ${this.lastError}`);
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    // Load RDB first, then replay AOF (AOF wins)
    this.loadRDB();
    this.loadAOF();
    if (this.aofEnabled) {
      try {
        this.aofFd = fs.openSync(this.aofFile, 'a');
      } catch (e) {
        this._recordError('AOF open', e);
        this.aofFd = null; // appends will be counted as errors in log()
      }
    }
    // autosave timer
    setInterval(() => this.autoSaveCheck(), 1000).unref();
  }

  log(argv) {
    if (!this.aofEnabled) return;
    if (this.aofFd === null) {
      this._recordError('AOF append (no fd)', new Error('append skipped: AOF file not open'));
      return;
    }
    try {
      fs.writeSync(this.aofFd, encodeCommand(argv));
      this.dirty++; // only count persisted writes (was incremented even on failure)
    } catch (e) {
      this._recordError('AOF append', e);
    }
  }

  loadAOF() {
    if (!fs.existsSync(this.aofFile)) return;
    const { tryParseOne } = require('./resp');
    let data;
    try {
      data = fs.readFileSync(this.aofFile);
    } catch (e) {
      this._recordError('AOF read', e);
      return;
    }
    if (!data.length) return;
    // Record-by-record prefix parse: replay the longest complete valid prefix.
    // A torn/corrupt tail stops the scan (it is quarantined below); unlike the
    // streaming Parser (which throws on first bad framing), startup salvages
    // everything before the damage instead of replaying nothing.
    const cmds = [];
    let off = 0, tornAt = -1;
    while (off < data.length) {
      if (data[off] !== 0x2a /* '*' */) { tornAt = off; break; } // AOF holds only arrays
      let r;
      try {
        r = tryParseOne(data, off);
      } catch {
        tornAt = off; // corrupt framing: stop, do not replay at/after damage
        break;
      }
      if (!r) { tornAt = off; break; } // incomplete trailing record
      const v = r.value;
      if (!Array.isArray(v) || v.some(x => x instanceof Error)) { tornAt = off; break; }
      cmds.push(v.map(x => (Buffer.isBuffer(x) ? x.toString('latin1') : (x === null || x === undefined ? '' : String(x)))));
      off = r.next;
    }
    if (tornAt >= 0 && tornAt < data.length) {
      // Quarantine: truncate the damaged tail so later appends frame cleanly.
      console.error(`[persist] AOF has ${data.length - tornAt} damaged trailing byte(s); replaying ${cmds.length} complete op(s), truncating damaged tail`);
      try {
        const fdT = fs.openSync(this.aofFile, 'r+');
        try { fs.ftruncateSync(fdT, tornAt); } finally { fs.closeSync(fdT); }
      } catch (e) {
        this._recordError('AOF damaged-tail truncate', e);
      }
    }
    let db = 0; // SELECT is tracked by the caller (applyWrite is stateless per call)
    let replayed = 0, skipped = 0;
    for (let i = 0; i < cmds.length; i++) {
      const argv = cmds[i];
      try {
        // Validate record shape before replay: never execute phantom/misframed data.
        if (!Array.isArray(argv) || !argv.length) throw new Error('empty command in AOF');
        if (typeof argv[0] !== 'string' || !argv[0].length) throw new Error('bad command name in AOF');
        if (argv[0] && String(argv[0]).toUpperCase() === 'SELECT') { db = Number(argv[1]) || 0; continue; }
        this.server.applyWrite(argv, { replay: true, db });
        replayed++;
      } catch (e) {
        skipped++;
        console.error(`[persist] AOF op #${i} (${argv[0] || '?'}): skipped: ${(e && e.message) || e}`);
      }
    }
    console.log(`[persist] replayed ${replayed} op(s) from AOF${skipped ? `, skipped ${skipped}` : ''}`);
  }

  saveRDB() {
    const tmp = this.rdbFile + '.tmp';
    let snap;
    try {
      snap = this.server.store.snapshot();
      snap.savedAt = Date.now();
      snap.redisCloneVer = '1.0.0';
    } catch (e) {
      this._recordError('RDB snapshot', e);
      throw new Error(`RDB save failed (snapshot): ${(e && e.message) || e}`);
    }
    try {
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, JSON.stringify(snap));
        fs.fsyncSync(fd); // durability: data on disk before the atomic rename
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.rdbFile);
    } catch (e) {
      this._recordError('RDB save', e);
      throw new Error(`RDB save failed: ${(e && e.message) || e}`);
    }
    this.lastSave = Date.now();
    this.lastSaveTime = Date.now();
    this.dirty = 0;
    console.log('[persist] RDB saved');
  }

  loadRDB() {
    if (!fs.existsSync(this.rdbFile)) return;
    let snap;
    try {
      snap = JSON.parse(fs.readFileSync(this.rdbFile, 'utf8'));
    } catch (e) {
      // Corrupt snapshot: refuse to silently start empty — operator action needed,
      // but keep the process up (previous behavior) so the failure is visible, not hidden.
      this._recordError('RDB load (starting with empty dataset)', e);
      return;
    }
    if (!snap || typeof snap.numDbs !== 'number' || !Array.isArray(snap.dbs)) {
      this._recordError('RDB load (starting with empty dataset)', new Error('invalid snapshot shape'));
      return;
    }
    try {
      this.server.store.restore(snap);
    } catch (e) {
      this._recordError('RDB restore (starting with empty dataset)', e);
      return;
    }
    this.lastSave = snap.savedAt || Date.now();
    console.log(`[persist] loaded RDB snapshot`);
  }

  rewriteAOF() {
    // Serialize current dataset as SET/RPUSH/HSET/SADD/ZADD/XADD commands
    const lines = [];
    const store = this.server.store;
    for (let dbi = 0; dbi < store.numDbs; dbi++) {
      const db = store.dbs[dbi];
      if (!db.size) continue;
      lines.push(['SELECT', String(dbi)]);
      for (const [k, e] of db) {
        if (e.expireAt && Date.now() >= e.expireAt) continue;
        const ttl = e.expireAt ? Math.max(1, e.expireAt - Date.now()) : null;
        switch (e.type) {
          case 'string':
            if (ttl) lines.push(['SET', k, String(e.value), 'PX', String(ttl)]);
            else lines.push(['SET', k, String(e.value)]);
            break;
          case 'list': if (e.value.length) lines.push(['RPUSH', k, ...e.value.map(String)]); break;
          case 'hash': if (e.value.size) { const a = ['HSET', k]; for (const [f, v] of e.value) a.push(f, String(v)); lines.push(a); } break;
          case 'set': if (e.value.size) lines.push(['SADD', k, ...[...e.value].map(String)]); break;
          case 'zset':
            if (e.geo && e.geo.size) {
              // geo index must round-trip as GEOADD (scores alone lose coordinates)
              const a = ['GEOADD', k];
              for (const [m, p] of e.geo) a.push(String(p.lon), String(p.lat), m);
              lines.push(a);
            } else if (e.value.map.size) { const a = ['ZADD', k]; for (const [m, s] of e.value.map) a.push(String(s), m); lines.push(a); }
            break;
          case 'stream': {
            for (const en of (e.value.entries || [])) { const a = ['XADD', k, en.id]; for (const [f, v] of Object.entries(en.fields)) a.push(f, String(v)); lines.push(a); }
            // recreate consumer groups (pending deliveries are not preserved)
            for (const [g, grp] of Object.entries(e.value.groups || {})) {
              lines.push(['XGROUP', 'CREATE', k, g, grp.lastId || '$', 'MKSTREAM']);
            }
            break;
          }
        }
        if (ttl && e.type !== 'string') lines.push(['PEXPIRE', k, String(ttl)]);
      }
    }
    lines.push(['SELECT', '0']);
    const tmp = this.aofFile + '.tmp';
    try {
      const fd = fs.openSync(tmp, 'w');
      try {
        for (const argv of lines) fs.writeSync(fd, encodeCommand(argv));
        fs.fsyncSync(fd); // durability: rewritten content on disk before swap
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.aofFile);
    } catch (e) {
      this._recordError('AOF rewrite', e);
      throw new Error(`AOF rewrite failed: ${(e && e.message) || e}`);
    }
    // Reopen the append fd only after a successful swap; on failure the old
    // fd keeps working (previous code reopened unconditionally and could lose it).
    try {
      const fresh = fs.openSync(this.aofFile, 'a');
      if (this.aofFd) { try { fs.closeSync(this.aofFd); } catch {} }
      this.aofFd = fresh;
    } catch (e) {
      this._recordError('AOF reopen after rewrite', e);
      // keep old fd if it is still usable; log() reports a null fd loudly
    }
    console.log('[persist] AOF rewritten');
  }

  autoSaveCheck() {
    const now = Date.now();
    for (const [sec, changes] of this.savepoints) {
      if (this.dirty >= changes && now - this.lastSaveTime >= sec * 1000) {
        try { this.saveRDB(); } catch (e) { console.error('[persist] autosave failed:', (e && e.message) || e); }
        break;
      }
    }
  }
}

module.exports = { Persistence };
