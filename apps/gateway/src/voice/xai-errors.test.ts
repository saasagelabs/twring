import { describe, expect, it } from 'vitest';

import { HandshakeRefusedError } from './socket';
import { xaiConnectError } from './xai-errors';

describe('xaiConnectError', () => {
  it('a 400 that says the key is wrong is a refused key', () => {
    const error = new HandshakeRefusedError(
      400,
      '{"code":"Client specified an invalid argument","error":"Incorrect API key provided."}',
    );
    expect(xaiConnectError(error)).toEqual({ code: 'auth_failed', recoverable: false });
  });

  it('any other 400 stays a bad request', () => {
    expect(xaiConnectError(new HandshakeRefusedError(400, '{"error":"bad voice"}'))).toEqual({
      code: 'provider_error',
      recoverable: false,
    });
    expect(xaiConnectError(new Error('Unexpected server response: 400'))).toEqual({
      code: 'provider_error',
      recoverable: false,
    });
  });

  it('401 is still a refused key and 503 still retryable', () => {
    expect(xaiConnectError(new HandshakeRefusedError(401, ''))).toEqual({
      code: 'auth_failed',
      recoverable: false,
    });
    expect(xaiConnectError(new HandshakeRefusedError(503, ''))).toEqual({
      code: 'connection_lost',
      recoverable: true,
    });
  });
});
