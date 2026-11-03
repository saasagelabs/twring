// Answers health checks but is not the process the smoke script launched (wrong release).
import { createServer } from 'node:http';

createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end('{"status":"ready","release":"someone-else"}');
}).listen(Number(process.env.PORT), '127.0.0.1');
