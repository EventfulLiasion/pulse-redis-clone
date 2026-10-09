# Pulse Redis Clone ⚡

![CI](https://github.com/YOUR_USERNAME/pulse-redis-clone/actions/workflows/ci.yml/badge.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Deps](https://img.shields.io/badge/dependencies-0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

A Redis clone built from scratch — **zero dependencies**, pure Node.js.
Implements the RESP2/RESP3 wire protocol, so real Redis clients
(`redis-cli`, `ioredis`, `redis-py`) can talk to it.

> Replace `YOUR_USERNAME` in the badge URL and `package.json` with your
> GitHub username after pushing.

## Prerequisites

- Node.js **18+** (developed and tested on 18, 20, 22)
- Nothing else — no packages to install, no build step.

## Quickstart

```bash
git clone https://github.com/YOUR_USERNAME/pulse-redis-clone.git
cd pulse-redis-clone
node src/server.js --port 6379 --dir ./data   # terminal 1: start the server
```

```bash
node src/cli.js --port 6379                    # terminal 2: talk to it
```

```
127.0.0.1:6379> PING
"PONG"
127.0.0.1:6379> SET name bro
"OK"
127.0.0.1:6379> GET name
"bro"
127.0.0.1:6379> INCR visits
1
```

## Features (120+ commands)

- **RESP2 + RESP3** parser/serializer with pipelining + partial-frame handling
- **Types**: strings, lists, hashes, sets, sorted sets (skiplist-style ordering), streams, bitmaps, HyperLogLog, geospatial
- **Expiry**: lazy + active (100ms cycle), `EX/PX/EXAT/PXAT/KEEPTTL/NX/XX/GT/LT`
- **Transactions**: `MULTI/EXEC/DISCARD/WATCH/UNWATCH` with optimistic locking
- **Blocking**: `BLPOP/BRPOP/BLMOVE/BZPOPMIN/BZPOPMAX/XREAD BLOCK`
- **Pub/Sub**: channels + patterns + `PUBSUB` introspection
- **Streams**: `XADD/XREAD/XRANGE/XTRIM/XDEL/XGROUP/XREADGROUP/XACK/XPENDING/XINFO`
- **Scripting**: `EVAL/EVALSHA/SCRIPT` (JS engine via `vm`, `redis.call`)
- **Server**: `INFO/CONFIG/CLIENT/SLOWLOG/MONITOR/SAVE/BGSAVE/BGREWRITEAOF/SCAN`
- **Persistence**: AOF log + JSON RDB snapshots + auto `save` points + rewrite
- **Eviction**: `maxmemory` + `noeviction/allkeys-lru/volatile-lru/allkeys-random/volatile-ttl/allkeys-lfu`
- **Replication**: `REPLICAOF/PSYNC` streaming (master → replica), `ROLE/WAIT`
- **16 databases** (`SELECT/MOVE`), `COPY/SORT/OBJECT/BITFIELD/BITOP`

## Run

```bash
node src/server.js --port 6379 --dir ./data
node src/cli.js [--host 127.0.0.1] [--port 6379]
```

## Test

```bash
npm test             # everything: integration + adversarial + phase2 + persistence + CLI checks
npm run test:run     # integration suite only (18 groups)
npm run test:adv     # adversarial suite (38 checks)
npm run test:phase2  # replication / pub-sub / AOF-rewrite verification
npm run test:persist # torn-AOF / corrupt-RDB / persistence-health checks
node tests/bench.js 6379
```

No genuine-Redis server is required for any suite above. Each suite spawns
its own server on its own ports with an isolated temp data dir, so suites
never share state (override ports via `PULSE_TEST_PORT`, `PULSE_ADV_PORT`,
`PULSE_PM_PORT`/`PULSE_PR_PORT`, `PULSE_PERS_*_PORT` if needed).

## Durability (honest guarantees)

- AOF appends use `write()` **without per-command fsync**: a crash can lose
  the most recent appended writes (same trade-off as Redis `appendfsync no`).
- RDB snapshots (`SAVE`/`BGSAVE`/autosave) and `BGREWRITEAOF` **are fsync'd
  before the atomic rename**: a completed save is crash-safe.
- A torn trailing AOF record (crash mid-append) is detected on startup: the
  complete prefix replays, the torn tail is truncated, and a message is
  logged. A file that fails RESP framing earlier replays **nothing** (loud
  error, process stays up).
- A corrupt/unparseable RDB snapshot is **not** loaded; the server starts
  empty and logs an error — operator action required.
- Persistence health is visible via `INFO persistence`
  (`aof_write_errors`, `aof_last_write_status`, `aof_last_error`).
  Append/rewrite/save failures are logged to stderr, never silently dropped.
- Replication is fire-and-forget streaming with **no backlog**: a replica
  only receives writes issued while it is attached. `PSYNC` always performs
  a full (snapshot-less) resync, not a partial one.

## Layout

```
src/resp.js        RESP2/RESP3 codec + incremental parser
src/datastore.js   multi-DB store, expiry, LRU/LFU, snapshots
src/helpers.js     shared command helpers
src/cmd_core.js    connection/server/keys/strings/lists/hashes + SCAN
src/cmd_advanced.js sets/zsets/streams/bitmaps/HLL/geo/pubsub/scripts
src/commands.js    dispatcher + write-set
src/server.js      TCP server, blocking, pub/sub fan-out, replication
src/persistence.js AOF + RDB
src/cli.js         mini redis-cli
tests/run.js       18 integration tests over TCP
tests/adversarial.js 38 adversarial checks (protocol, semantics, persistence)
tests/verify_phase2.js replication / pub-sub / AOF-rewrite verification
tests/run_all.js   combined workflow (all suites + CLI checks)
tests/helpers.js   shared harness: readiness checks, stderr capture, temp dirs
```

## Contributing

Issues and pull requests are welcome. CI runs `npm test` on Node 18/20/22
across Ubuntu, Windows, and macOS — please make sure it passes locally
before opening a PR. Bug reports should include the server log lines and
the failing command sequence if possible.

## License

MIT — see [LICENSE](LICENSE).
