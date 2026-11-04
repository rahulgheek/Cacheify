'use strict';

/**
 * Docker HEALTHCHECK probe: connects to the gateway and expects a +PONG.
 * Deliberantly runs BEFORE AUTH: the gateway answers PING locally without
 * authentication (documented), so liveness never touches the REST plane.
 */

const net = require('net');

const port = Number(process.env.GATEWAY_PORT || process.env.PORT || 6379);
const host = process.env.GATEWAY_HOST || '127.0.0.1';

const socket = net.connect({ host, port, timeout: 2500 });
const fail = () => process.exit(1);
socket.on('error', fail);
socket.on('timeout', fail);
socket.connect || socket.on('connect', () => {
  // RESP2 inline health check (no AUTH needed for PING by contract).
  socket.write(Buffer.from('*1\r\n$4\r\nPING\r\n', 'ascii'));
});
socket.on('data', (chunk) => {
  process.exit(chunk.includes('PONG') ? 0 : 1);
});
