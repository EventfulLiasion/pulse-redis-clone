'use strict';
/* Combined test workflow: runs every suite sequentially with isolated ports
 * and temp dirs, plus CLI argument regression checks. Nonzero exit if
 * anything required fails. Usage: node tests/run_all.js */
const { spawnSync, spawn } = require('child_process');
const path = require('path');

const SUITES = [
  { name: 'integration (18 groups)', file: 'run.js', env: { PULSE_TEST_PORT: '17379' } },
  { name: 'adversarial (38 checks)', file: 'adversarial.js', env: { PULSE_ADV_PORT: '17380' } },
  { name: 'phase2 (replication/pubsub/rewrite)', file: 'verify_phase2.js', env: { PULSE_PM_PORT: '17411', PULSE_PR_PORT: '17412' } },
  { name: 'persistence (torn-AOF/corrupt-RDB/health)', file: 'verify_persistence.js', env: { PULSE_PERS_TORN_PORT: '17431', PULSE_PERS_RDB_PORT: '17432', PULSE_PERS_INFO_PORT: '17433' } },
];

function runSuite(s) {
  console.log(`\n=== ${s.name}: node tests/${s.file} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, s.file)], {
    env: { ...process.env, ...s.env },
    encoding: 'utf8',
    timeout: 180000,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) {
    console.error(`suite harness error: ${r.error.message}`);
    return false;
  }
  if (r.status !== 0) {
    console.error(`suite FAILED (exit ${r.status}${r.signal ? ` signal ${r.signal}` : ''})`);
    return false;
  }
  return true;
}

function runCliChecks() {
  console.log('\n=== CLI argument parsing ===');
  let ok = true;
  // in-process parser checks (no network)
  const { parseArgs } = require('../src/cli.js');
  const cases = [
    [[], '127.0.0.1', 6379],
    [['--port', '6379'], '127.0.0.1', 6379],
    [['--host', '10.0.0.1'], '10.0.0.1', 6379],
    [['--host', '10.0.0.1', '--port', '6380'], '10.0.0.1', 6380],
    [['--port', '6380', '--host', '10.0.0.1'], '10.0.0.1', 6380],
  ];
  for (const [argv, host, port] of cases) {
    let got;
    try { got = parseArgs(argv); }
    catch (e) { console.error(`FAIL parseArgs(${JSON.stringify(argv)}): threw ${e.message}`); ok = false; continue; }
    if (got.host !== host || got.port !== port) {
      console.error(`FAIL parseArgs(${JSON.stringify(argv)}): got ${JSON.stringify(got)}, want host=${host} port=${port}`);
      ok = false;
    } else console.log(`  ok - parseArgs(${argv.join(' ') || '(none)'}) -> ${host}:${port}`);
  }
  // child-process checks: --help exits 0, bad args exit 2 (no server needed)
  const kids = [
    { argv: ['--help'], want: 0, label: '--help exits 0' },
    { argv: ['--port', 'abc'], want: 2, label: 'bad port exits 2' },
    { argv: ['--port', '99999'], want: 2, label: 'out-of-range port exits 2' },
    { argv: ['--bogus'], want: 2, label: 'unknown flag exits 2' },
    { argv: ['--port'], want: 2, label: 'missing value exits 2' },
  ];
  for (const k of kids) {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), ...k.argv], { encoding: 'utf8', timeout: 15000 });
    if (r.status !== k.want) {
      console.error(`FAIL cli ${k.label}: exit=${r.status} stderr=${JSON.stringify((r.stderr || '').slice(0, 200))}`);
      ok = false;
    } else console.log(`  ok - cli ${k.label}`);
  }
  // connecting CLI against a live server (default args must target 127.0.0.1:PORT)
  return ok;
}

async function liveCliCheck() {
  console.log('\n=== CLI live connect (PING) ===');
  const { startServer, connect } = require('./helpers');
  const { encodeCommand } = require('../src/resp');
  const port = Number(process.env.PULSE_CLI_PORT || 17421);
  const dir = path.join(__dirname, `tmpcli-${process.pid}`);
  const srv = startServer({ port, dir });
  try {
    await srv.ready;
  } catch (e) {
    console.error(`FAIL live CLI: server did not start: ${e.message} ${srv.describe()}`);
    return false;
  }
  // drive the real CLI binary with piped stdin against the live server
  const cli = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), '--port', String(port)], { encoding: 'utf8' });
  let out = '';
  const done = new Promise((res) => {
    const t = setTimeout(() => { try { cli.kill(); } catch {} res(false); }, 10000);
    cli.stdout.on('data', (d) => {
      out += d;
      if (/connected to pulse-redis/.test(out) && !cli._sent) { cli._sent = true; cli.stdin.write('PING\n'); }
      if (/"PONG"/.test(out)) { clearTimeout(t); res(true); }
    });
    cli.on('exit', () => { clearTimeout(t); res(/"PONG"/.test(out)); });
  });
  const ok = await done;
  try { cli.kill(); } catch {}
  srv.kill();
  try { require('./helpers').removeTempDir(dir); } catch (e) { console.error(`cleanup: ${e.message}`); return false; }
  console.log(ok ? '  ok - CLI connects with default host and PING->PONG' : `  FAIL - CLI live output: ${JSON.stringify(out.slice(0, 500))}`);
  return ok;
}

async function main() {
  let allOk = true;
  for (const s of SUITES) {
    if (!runSuite(s)) allOk = false;
  }
  if (!runCliChecks()) allOk = false;
  if (!await liveCliCheck()) allOk = false;
  console.log('\n' + (allOk ? 'ALL SUITES PASSED' : 'FAILURES PRESENT'));
  process.exit(allOk ? 0 : 1);
}
main().catch(e => { console.error('run_all FATAL: ' + ((e && e.stack) || e)); process.exit(2); });
