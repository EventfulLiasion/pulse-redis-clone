'use strict';
/**
 * RESP2 + RESP3 parser & serializer, zero dependencies.
 * Supports pipelining, partial TCP chunks, inline commands.
 */

const CRLF = '\r\n';

function encodeSimpleString(s) { return `+${s}${CRLF}`; }
function encodeError(msg) { return `-${msg}${CRLF}`; }
function encodeInt(n) { return `:${Math.trunc(n)}${CRLF}`; }
function encodeBulk(str) {
  if (str === null || str === undefined) return '$-1\r\n';
  // latin1 preserves bytes 0-255 one-to-one (binary-safe transport)
  const b = Buffer.isBuffer(str) ? str : Buffer.from(String(str), 'latin1');
  return Buffer.concat([Buffer.from(`$${b.length}${CRLF}`), b, Buffer.from(CRLF)]);
}
function encodeBulkStringOnly(s) { return encodeBulk(s); }

function encode(value) {
  // null / undefined
  if (value === null || value === undefined) return Buffer.from('$-1\r\n');
  // Error instance -> RESP error (don't double-prefix codes like WRONGTYPE/NOSCRIPT)
  if (value instanceof Error) {
    const m = String(value.message || 'error');
    const coded = /^[A-Z][A-Z0-9-]*(\s|$)/.test(m);
    return Buffer.from(`-${coded ? m : 'ERR ' + m}${CRLF}`);
  }
  // Special wrappers
  if (typeof value === 'object' && value !== null && value.__resp) {
    return Buffer.from(value.__resp, 'utf8');
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return Buffer.from(encodeInt(value));
    // floats -> bulk string (like Redis does for scores)
    return encodeBulk(String(value));
  }
  if (typeof value === 'bigint') return Buffer.from(`(${value.toString()}${CRLF}`);
  if (typeof value === 'boolean') return Buffer.from(value ? '#t\r\n' : '#f\r\n');
  if (typeof value === 'string' || Buffer.isBuffer(value)) return encodeBulk(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return Buffer.from('*0\r\n');
    const parts = [Buffer.from(`*${value.length}${CRLF}`)];
    for (const el of value) parts.push(Buffer.isBuffer(el) ? el : encode(el));
    return Buffer.concat(parts);
  }
  // plain object -> encode as bulk string JSON (fallback)
  return encodeBulk(String(value));
}

function simple(s) { return { __resp: `+${s}${CRLF}` }; }
function err(msg) { return { __resp: `-${msg}${CRLF}` }; }
function ok() { return { __resp: '+OK\r\n' }; }
function nullBulk() { return { __resp: '$-1\r\n' }; }
function nullArray() { return { __resp: '*-1\r\n' }; }

const OK = () => ({ __resp: '+OK\r\n' });
const PONG = () => ({ __resp: '+PONG\r\n' });

const MAX_BULK = 512 * 1024 * 1024; // 512MB like redis proto-max-bulk-len
const MAX_ARGS = 1024 * 1024;         // hard cap on multibulk arg count

/**
 * Incremental parser — one instance per TCP connection.
 * feed(chunk: Buffer) -> Array<Array<string>> (commands as string arrays)
 * Bulk bytes are decoded latin1 (binary-safe: bytes round-trip one-to-one).
 * Throws on protocol errors (caller must reset the parser buffer).
 */
class Parser {
  constructor() { this.buf = Buffer.alloc(0); }
  feed(chunk) {
    if (chunk && chunk.length) this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    while (true) {
      if (this.buf.length === 0) break;
      // Inline command? (doesn't start with *; telnet / health checks)
      if (this.buf[0] !== 0x2a /* * */) {
        const idx = this.buf.indexOf('\r\n');
        if (idx === -1) break; // incomplete line
        const line = this.buf.slice(0, idx).toString('utf8').trim();
        this.buf = this.buf.slice(idx + 2);
        if (!line) continue;
        out.push(splitInline(line));
        continue;
      }
      const parsed = tryParseOne(this.buf, 0);
      if (!parsed) break; // need more data
      this.buf = this.buf.slice(parsed.next);
      // RESP array -> command args (bulk bytes decoded latin1, binary-safe)
      let cmd = parsed.value;
      if (cmd === null || cmd === undefined) throw new Error('Protocol error: null command');
      if (cmd instanceof Error) throw cmd;
      if (!Array.isArray(cmd)) cmd = [cmd];
      if (cmd.some(v => v instanceof Error)) throw new Error('Protocol error: bad bulk');
      out.push(cmd.map(v => (Buffer.isBuffer(v) ? v.toString('latin1') : (v === null || v === undefined ? '' : String(v)))));
    }
    return out;
  }
}

function splitInline(line) {
  // split respecting double quotes
  const args = [];
  let cur = '', inQ = false, q = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === q) inQ = false;
      else if (c === '\\' && i + 1 < line.length) { cur += line[++i]; }
      else cur += c;
    } else {
      if (c === '"' || c === "'") { inQ = true; q = c; }
      else if (c === ' ' || c === '\t') { if (cur) { args.push(cur); cur = ''; } }
      else cur += c;
    }
  }
  if (cur) args.push(cur);
  return args;
}

// Try parse one RESP value at offset. Returns {value, next} or null if incomplete.
function tryParseOne(buf, off) {
  if (off >= buf.length) return null;
  const prefix = String.fromCharCode(buf[off]);
  // Inline fallback (shouldn't happen here)
  if (!'+-:$*_#,(=!%|>\r\n'.includes(prefix) && prefix !== '*') {
    const idx = buf.indexOf('\r\n', off);
    if (idx === -1) return null;
    return { value: buf.slice(off, idx).toString(), next: idx + 2 };
  }
  const lineEnd = indexOfCRLF(buf, off);
  if (lineEnd === -1) return null;
  const line = buf.slice(off + 1, lineEnd).toString('utf8');

  switch (prefix) {
    case '+': return { value: line, next: lineEnd + 2 };
    case '-': return { value: new Error(line), next: lineEnd + 2 };
    case ':': return { value: parseInt(line, 10), next: lineEnd + 2 };
    case '(': return { value: parseInt(line, 10), next: lineEnd + 2 }; // big number -> int
    case ',': return { value: parseFloat(line), next: lineEnd + 2 };   // double
    case '#': return { value: line === 't', next: lineEnd + 2 };       // boolean
    case '_': return { value: null, next: lineEnd + 2 };               // null
    case '$':
    case '!':
    case '=': {
      const len = parseInt(line, 10);
      if (Number.isNaN(len) || len < -1) throw new Error('Protocol error: invalid bulk length');
      if (len === -1) return { value: null, next: lineEnd + 2 };
      if (len > MAX_BULK) throw new Error('Protocol error: bulk string too long');
      // verbatim (=) has 4-byte format prefix e.g. "txt:..." — strip it
      if (prefix === '=' && len > 4) {
        if (lineEnd + 2 + len + 2 > buf.length) return null; // incomplete
        if (buf[lineEnd + 2 + len] !== 13 || buf[lineEnd + 2 + len + 1] !== 10) {
          throw new Error('Protocol error: bad verbatim terminator');
        }
        const raw = buf.slice(lineEnd + 2, lineEnd + 2 + len);
        // strip "txt:" prefix
        const str = raw.slice(4).toString();
        return { value: str, next: lineEnd + 2 + len + 2 };
      }
      if (lineEnd + 2 + len + 2 > buf.length) return null; // incomplete
      if (buf[lineEnd + 2 + len] !== 13 || buf[lineEnd + 2 + len + 1] !== 10) {
        throw new Error('Protocol error: bad bulk terminator');
      }
      const data = buf.slice(lineEnd + 2, lineEnd + 2 + len);
      return { value: data, next: lineEnd + 2 + len + 2 };
    }
    case '*':
    case '%':
    case '|':
    case '>': {
      let count = parseInt(line, 10);
      if (Number.isNaN(count)) throw new Error('Protocol error: invalid multibulk length');
      if (count === -1) return { value: null, next: lineEnd + 2 };
      if (count < -1 || count > MAX_ARGS) throw new Error('Protocol error: invalid multibulk length');
      if (prefix === '%') count *= 2; // map -> flat array
      let cur = lineEnd + 2;
      const arr = [];
      for (let i = 0; i < count; i++) {
        const r = tryParseOne(buf, cur);
        if (!r) return null;
        arr.push(r.value);
        cur = r.next;
      }
      if (prefix === '%') {
        // convert flat -> object-ish: keep as array of pairs flattened? Return dict object
        const obj = {};
        for (let i = 0; i < arr.length; i += 2) obj[String(arr[i])] = arr[i + 1];
        return { value: obj, next: cur };
      }
      return { value: arr, next: cur };
    }
    default: return null;
  }
}

function indexOfCRLF(buf, from) {
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) return i;
  }
  return -1;
}

/** Encode argv array to RESP (for AOF + replication + redis-cli). */
function encodeCommand(argv) {
  const parts = [Buffer.from(`*${argv.length}${CRLF}`)];
  for (const a of argv) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'latin1');
    parts.push(Buffer.from(`$${b.length}${CRLF}`), b, Buffer.from(CRLF));
  }
  return Buffer.concat(parts);
}

/** Decode a single RESP reply buffer (for tests/CLI). */
function decodeReply(buf) {
  const r = tryParseOne(Buffer.isBuffer(buf) ? buf : Buffer.from(buf), 0);
  return r ? r.value : null;
}

module.exports = { Parser, encode, encodeCommand, decodeReply, tryParseOne, simple, err, ok, OK, PONG, nullBulk, nullArray, encodeSimpleString, encodeError, encodeInt, encodeBulk };
