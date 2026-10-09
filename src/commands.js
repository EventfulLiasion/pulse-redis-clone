'use strict';
const { registerCore } = require('./cmd_core');
const { registerAdvanced } = require('./cmd_advanced');

const table = {};
registerCore(table);
registerAdvanced(table);

// aliases
table.getset = table.getset;
table.slaveof = table.replicaof;

const WRITE = new Set([
  'set', 'getset', 'getdel', 'setnx', 'setex', 'psetex', 'mset', 'append', 'setrange',
  'incr', 'decr', 'incrby', 'decrby', 'incrbyfloat',
  'lpush', 'rpush', 'lpushx', 'rpushx', 'lpop', 'rpop', 'lset', 'lrem', 'ltrim', 'lmove', 'rpoplpush',
  'hset', 'hmset', 'hdel', 'hincrby', 'hincrbyfloat', 'hsetnx',
  'sadd', 'srem', 'smove', 'spop', 'sunionstore', 'sinterstore', 'sdiffstore',
  'zadd', 'zrem', 'zincrby', 'zpopmin', 'zpopmax', 'zremrangebyscore', 'zremrangebyrank', 'zremrangebylex',
  'zunionstore', 'zinterstore', 'zdiffstore',
  'xadd', 'xtrim', 'xdel', 'xgroup', 'xack',
  'setbit', 'bitop', 'bitfield',
  'pfadd', 'pfmerge',
  'geoadd',
  'del', 'unlink', 'rename', 'renamenx', 'move', 'copy', 'restore', 'sort',
  'expire', 'expireat', 'pexpire', 'pexpireat', 'persist',
  'flushdb', 'flushall', 'select',
  'eval', 'evalsha',
  // NOTE: publish is deliberately NOT a write: it changes no dataset state and
  // must not bloat the AOF or advance the replication offset.
]);

function isWrite(cmd) { return WRITE.has(String(cmd || '').toLowerCase()); }

function execute(server, client, argv, send) {
  if (!argv.length) throw new Error('empty command');
  const name = String(argv[0]).toLowerCase();
  const fn = table[name];
  if (!fn) throw new Error(`unknown command '${argv[0]}', with args starting with: ${argv.slice(1, 3).map(String).join(', ')}`);
  // subscriber-mode guard (mirrors Redis)
  if (client.subscribed && !['subscribe', 'unsubscribe', 'psubscribe', 'punsubscribe', 'ping', 'quit', 'reset'].includes(name)) {
    throw new Error(`Can't execute '${argv[0]}': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context`);
  }
  return fn(server, client, argv, send);
}

module.exports = { table, execute, isWrite, commandCount: () => Object.keys(table).length };
