import * as http from 'node:http';
import * as https from 'node:https';

import {
  assertSafeAgentEndpoint,
  pinnedLookup,
  type EndpointGuardOptions,
} from '@twring/agent-adapter';
import { MAX_FILE_BYTES } from '@twring/contracts';

export type AgentFileFailure = 'blocked' | 'too_large' | 'http_status' | 'timeout' | 'network';

export class FetchAgentFileError extends Error {
  constructor(readonly code: AgentFileFailure) {
    super(code);
    this.name = 'FetchAgentFileError';
  }
}

/** Fetches only the prevalidated address. The original URL remains the Host and TLS name. */
export async function fetchAgentFile(
  raw: string,
  signal: AbortSignal,
  options: EndpointGuardOptions = { env: 'production' },
): Promise<{ bytes: Buffer; contentType: string | undefined }> {
  const started = Date.now();
  let abortGuard: (() => void) | undefined;
  let endpoint;
  try {
    const url = new URL(raw);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (
      url.protocol !== 'https:' &&
      !(options.env === 'development' && local && url.protocol === 'http:')
    )
      throw new FetchAgentFileError('blocked');
    endpoint = await Promise.race([
      assertSafeAgentEndpoint(url, {
        ...options,
        allowPrivateHosts: options.env === 'development' && local ? [url.hostname] : [],
        lookupTimeoutMs: Math.min(options.lookupTimeoutMs ?? 5_000, 20_000),
      }),
      new Promise<never>((_, reject) => {
        abortGuard = () => reject(new FetchAgentFileError('network'));
        if (signal.aborted) abortGuard();
        else signal.addEventListener('abort', abortGuard, { once: true });
      }),
    ]);
  } catch (cause) {
    if (cause instanceof FetchAgentFileError) throw cause;
    throw new FetchAgentFileError('blocked');
  } finally {
    if (abortGuard) signal.removeEventListener('abort', abortGuard);
  }
  if (signal.aborted) throw new FetchAgentFileError('network');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      error?: AgentFileFailure,
      result?: { bytes: Buffer; contentType: string | undefined },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(new FetchAgentFileError(error));
      else resolve(result!);
    };
    const req = (endpoint.url.protocol === 'https:' ? https : http).request(
      endpoint.url,
      {
        method: 'GET',
        lookup: pinnedLookup(endpoint.pinned),
        headers: { accept: '*/*' },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          finish('http_status');
          return;
        }
        const length = Number(response.headers['content-length']);
        if (
          response.headers['content-length'] !== undefined &&
          (!Number.isSafeInteger(length) || length < 0 || length > MAX_FILE_BYTES)
        ) {
          response.destroy();
          finish('too_large');
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_FILE_BYTES) {
            req.destroy();
            finish('too_large');
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          finish(undefined, {
            bytes: Buffer.concat(chunks),
            contentType: response.headers['content-type'],
          }),
        );
        response.on('error', () => finish('network'));
      },
    );
    const abort = () => {
      req.destroy();
      finish('network');
    };
    const timer = setTimeout(
      () => {
        req.destroy();
        finish('timeout');
      },
      Math.max(1, 20_000 - (Date.now() - started)),
    );
    signal.addEventListener('abort', abort, { once: true });
    req.on('error', () => finish('network'));
    req.end();
  });
}
