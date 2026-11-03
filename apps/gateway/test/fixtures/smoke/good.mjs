// Well-behaved stand-in for the gateway: echoes the release nonce the smoke script expects.
import { createServer } from 'node:http';

createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(
    req.url === '/health/live'
      ? '{"status":"ok"}'
      : JSON.stringify({ status: 'ready', release: process.env.CORD_RELEASE, checks: {} }),
  );
}).listen(Number(process.env.PORT), '127.0.0.1');
