'use strict';
/** Shared helpers for command implementations. */
const { newZSet, zsetAdd } = require('./datastore');

const DIRECT = Symbol('direct');

function WArity(cmd) { const e = new Error(`wrong number of arguments for '${cmd}' command`); e.code = 'ARITY'; return e; }
function WType() { return new Error('WRONGTYPE Operation against a key holding the wrong kind of value'); }
function Syntax() { return new Error('syntax error'); }
function NoKey(cmd) { return new Error(`no such key`); }

function toInt(s, fallback = null) {
  const n = parseInt(String(s), 10);
  return Number.isNaN(n) ? fallback : n;
}
function toFloat(s, fallback = null) {
  const n = parseFloat(String(s));
  return Number.isNaN(n) ? fallback : n;
}
function asString(v) { return Buffer.isBuffer(v) ? v.toString('utf8') : String(v); }

function requireEntry(server, client, key, type) {
  const e = server.store.get(client.db, key);
  if (!e) return null;
  if (type && e.type !== type) throw WType();
  return e;
}
function getOrCreate(server, client, key, type, factory) {
  let e = server.store.get(client.db, key);
  if (!e) {
    e = server.store.set(client.db, key, type, factory());
    return { e, created: true };
  }
  if (e.type !== type) throw WType();
  return { e, created: false };
}

function parseExpireArgs(args, i) {
  // args like [EX seconds|PX ms|EXAT ts|PXAT ms|KEEPTTL], returns {expireAt, nextI, get, persist}
  let expireAt = null, get = false, persist = false, nx = false, xx = false;
  while (i < args.length) {
    const o = String(args[i]).toUpperCase();
    if (o === 'EX' && i + 1 < args.length) { expireAt = Date.now() + Number(args[i + 1]) * 1000; i += 2; }
    else if (o === 'PX' && i + 1 < args.length) { expireAt = Date.now() + Number(args[i + 1]); i += 2; }
    else if (o === 'EXAT' && i + 1 < args.length) { expireAt = Number(args[i + 1]) * 1000; i += 2; }
    else if (o === 'PXAT' && i + 1 < args.length) { expireAt = Number(args[i + 1]); i += 2; }
    else if (o === 'KEEPTTL') { persist = true; i++; }
    else if (o === 'GET') { get = true; i++; }
    else if (o === 'NX') { nx = true; i++; }
    else if (o === 'XX') { xx = true; i++; }
    else break;
  }
  return { expireAt, nextI: i, get, persist, nx, xx };
}

function streamIdCompare(a, b) {
  const [am, as] = a.split('-').map(Number);
  const [bm, bs] = b.split('-').map(Number);
  if (am !== bm) return am - bm;
  return as - bs;
}
function nextStreamId(lastId) {
  const now = Date.now();
  if (!lastId) return `${now}-0`;
  const [m, s] = lastId.split('-').map(Number);
  if (now > m) return `${now}-0`;
  return `${m}-${s + 1}`;
}

// --- geo helpers ---
function geoHashEncode(lat, lon) {
  const base32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let latR = [-90, 90], lonR = [-180, 180], hash = '', bits = 0, val = 0, even = true;
  while (hash.length < 11) {
    if (even) {
      const mid = (lonR[0] + lonR[1]) / 2;
      if (lon >= mid) { val = val * 2 + 1; lonR[0] = mid; } else { val = val * 2; lonR[1] = mid; }
    } else {
      const mid = (latR[0] + latR[1]) / 2;
      if (lat >= mid) { val = val * 2 + 1; latR[0] = mid; } else { val = val * 2; latR[1] = mid; }
    }
    even = !even;
    if (++bits === 5) { hash += base32[val]; bits = 0; val = 0; }
  }
  return hash;
}
function haversineM(lon1, lat1, lon2, lat2) {
  const R = 6372795.477598;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function parseDist(v, unit) {
  v = Number(v);
  switch (String(unit || 'm').toLowerCase()) {
    case 'm': return v;
    case 'km': return v * 1000;
    case 'mi': return v * 1609.344;
    case 'ft': return v * 0.3048;
    default: return v;
  }
}

module.exports = { DIRECT, WArity, WType, Syntax, toInt, toFloat, asString, requireEntry, getOrCreate, parseExpireArgs, streamIdCompare, nextStreamId, geoHashEncode, haversineM, parseDist };
