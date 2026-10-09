'use strict';
/* Shared test-harness plumbing: server startup with readiness checks,
 * stderr capture, guarded temp-dir cleanup. No test assertions live here. */
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const TAIL = 4000;

function isTempDirName(dir) {
  const base = path.basename(path.resolve(dir));
  return base.startsWith('tmp');
}

/** Remove ONLY directories that look like test temp dirs (basename tmp*). */
function removeTempDir(dir) {
  if (!dir) return;
  if (!isTempDirName(dir)) {
    throw new Error(`refusing to delete non-temp directory: ${dir}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Poll until TCP port accepts, or reject. Rejects immediately if proc dies. */
function waitForPort(port, { timeout = 10000, proc = null, label = `port ${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let done = false;
    const fail = (msg) => {
      if (done) return;
      done = true;
      reject(new Error(`${label}: ${msg}`));
    };
    if (proc) {
      if (proc.exitCode !== null) {
        fail(`server exited before listening (code ${proc.exitCode}) stderr: ${stderrTail(proc)}`);
        return;
      }
      proc.once('exit', (code, sig) => fail(`server exited before listening (code ${code} signal ${sig}) stderr: ${stderrTail(proc)}`));
    }
    const tick = () => {
      if (done) return;
      if (proc && proc.exitCode !== null) {
        fail(`server exited before listening (code ${proc.exitCode}) stderr: ${stderrTail(proc)}`);
        return;
      }
      const s = net.createConnection({ port, host: '127.0.0.1' });
      s.once('connect', () => { if (!done) { done = true; s.end(); resolve(); } });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - t0 > timeout) fail(`not listening after ${timeout}ms`);
        else setTimeout(tick, 100);
      });
    };
    tick();
  });
}

function stderrTail(proc) {
  const log = (proc && proc._errLog) || '';
  return log.slice(-TAIL) || '(no stderr captured)';
}

/** Spawn a clone server; captures stderr; use handle.ready before connecting.
 * keepData skips the fresh-dir wipe (needed for restart roundtrips). */
function startServer({ port, dir, extraArgs = [], keepData = false } = {}) {
  if (!keepData) fs.rmSync(dir, { recursive: true, force: true });
  const proc = spawn(
    process.execPath,
    [path.join(__dirname, '..', 'src', 'server.js'), '--port', String(port), '--dir', dir, ...extraArgs],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  proc._errLog = '';
  proc._outLog = '';
  if (proc.stderr) proc.stderr.on('data', (d) => { proc._errLog += d.toString(); });
  if (proc.stdout) proc.stdout.on('data', (d) => { proc._outLog += d.toString(); });
  proc.on('error', (e) => { proc._errLog += `\n[spawn error: ${e.message}]`; });
  const ready = waitForPort(port, { proc, label: `server(:${port})` });
  return {
    proc,
    ready,
    describe() {
      return `exitCode=${proc.exitCode} signal=${proc.signalCode} stderrTail=${JSON.stringify(stderrTail(proc))}`;
    },
    kill() { try { proc.kill(); } catch {} },
  };
}

function connect(port, { timeout = 5000 } = {}) {
  return new Promise((res, rej) => {
    const s = net.createConnection({ port: Number(port), host: '127.0.0.1' });
    const t = setTimeout(() => { s.destroy(); rej(new Error(`connect to 127.0.0.1:${port} timed out after ${timeout}ms`)); }, timeout);
    s.once('connect', () => { clearTimeout(t); res(s); });
    s.once('error', (e) => { clearTimeout(t); rej(new Error(`connect to 127.0.0.1:${port} failed: ${e.message}`)); });
  });
}

/** Unique temp dir per run so parallel suites never share state. */
function tempDir(base) {
  if (!isTempDirName(path.join(__dirname, base))) throw new Error(`temp dir base must start with tmp: ${base}`);
  return path.join(__dirname, `${base}-${process.pid}`);
}

module.exports = { startServer, waitForPort, connect, removeTempDir, tempDir, stderrTail };
