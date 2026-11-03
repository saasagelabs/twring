// Sends headers and a partial JSON body, then stalls forever.
import { createServer } from 'node:http';

createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write('{"status":"re');
}).listen(Number(process.env.PORT), '127.0.0.1');
