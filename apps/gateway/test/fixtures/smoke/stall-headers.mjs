// Accepts connections but never sends a response.
import { createServer } from 'node:http';

createServer(() => {}).listen(Number(process.env.PORT), '127.0.0.1');
