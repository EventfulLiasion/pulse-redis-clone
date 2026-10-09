'use strict';
/** Simple benchmark: pipelined PING + SET/GET */
const net = require('net');
const { encodeCommand } = require('../src/resp');
const PORT = Number(process.argv[2] || 6379);

const sock = net.createConnection({ port: PORT }, async () => {
  const N = 20000;
  console.log(`bench: ${N} PING pipelined...`);
  let t0 = Date.now();
  const batch = Buffer.concat(Array.from({ length: N }, () => encodeCommand(['PING'])));
  sock.write(batch);
  let got = 0, buf = Buffer.alloc(0);
  await new Promise(res => {
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      // count \r\n-terminated PONG replies (+PONG\r\n)
      const m = buf.toString().match(/\+PONG\r\n/g);
      got = m ? m.length : 0;
      if (got >= N) res();
    });
  });
  console.log(`  ${N} PING in ${Date.now() - t0}ms = ${Math.floor(N / ((Date.now() - t0) / 1000))} ops/sec`);
  sock.end();
});
