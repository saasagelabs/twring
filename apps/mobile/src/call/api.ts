import {
  createCallResponseSchema,
  errorResponseSchema,
  type CreateCallRequest,
  type CreateCallResponse,
  type ErrorCode,
} from '@twring/contracts';

import { SERVER_MESSAGE_MAX } from '../api/client';
import { withAuth, type ApiAuth } from '../auth/controller';

/** Why a call API request failed; server text is kept only for `speech_key_*` and sign-out codes. */
export class CallApiError extends Error {
  constructor(
    readonly kind: 'network' | 'timeout' | 'http' | 'invalid_response',
    readonly code?: ErrorCode,
    readonly requestId?: string,
    /** With `daily_limit_reached`: when today's allowance renews. */
    readonly resetsAt?: Date,
    /** The server's sentence; only kept for `speech_key_*` codes and a self-hosted sign-out. */
    readonly serverMessage?: string,
  ) {
    super(`call api ${kind}${code ? ` ${code}` : ''}`);
    this.name = 'CallApiError';
  }
}

export interface CallApi {
  /** `request.agent_id` calls that saved agent; without it the gateway's test line answers. */
  create(signal: AbortSignal, request?: CreateCallRequest): Promise<CreateCallResponse>;
  end(callId: string, signal: AbortSignal): Promise<void>;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface CallApiOptions {
  baseUrl: string;
  /** LiveKit must be wss:// outside development even if a server says otherwise. */
  requireSecureMedia: boolean;
  fetch?: Fetch;
  /** Signed-in token hooks (ADR-021); absent when sign-in is off. */
  auth?: ApiAuth;
  /** A person's own server: requests carrying its token follow no redirect. */
  rejectRedirects?: boolean;
}

/** Server text is kept for the speech key codes (it names the provider) and a self-hosted sign-out. */
function keepsServerMessage(code: string): boolean {
  return code.startsWith('speech_key_') || code === 'device_removed' || code === 'auth_required';
}

function authCodeOf(
  error: unknown,
): 'auth_invalid' | 'auth_required' | 'device_removed' | undefined {
  if (!(error instanceof CallApiError) || error.kind !== 'http') return undefined;
  return error.code === 'auth_invalid' ||
    error.code === 'auth_required' ||
    error.code === 'device_removed'
    ? error.code
    : undefined;
}

export function createCallApi(options: CallApiOptions): CallApi {
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const base = options.baseUrl.replace(/\/+$/, '');

  function post(path: string, signal: AbortSignal, payload: object = {}): Promise<unknown> {
    return withAuth(options.auth, (headers) => send(path, signal, payload, headers), authCodeOf);
  }

  async function send(
    path: string,
    signal: AbortSignal,
    payload: object,
    authHeaders: Record<string, string>,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify(payload),
        ...(options.rejectRedirects === true && { redirect: 'error' as const }),
        signal,
      });
    } catch {
      throw new CallApiError(signal.aborted ? 'timeout' : 'network');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CallApiError(response.ok ? 'invalid_response' : 'http');
    }
    if (!response.ok) {
      const parsed = errorResponseSchema.safeParse(body);
      throw new CallApiError(
        'http',
        parsed.success ? parsed.data.error.code : undefined,
        parsed.success ? parsed.data.error.request_id : undefined,
        parsed.success && parsed.data.error.resets_at !== undefined
          ? new Date(parsed.data.error.resets_at)
          : undefined,
        parsed.success && keepsServerMessage(parsed.data.error.code)
          ? parsed.data.error.message.slice(0, SERVER_MESSAGE_MAX)
          : undefined,
      );
    }
    return body;
  }

  return {
    async create(signal, request = {}) {
      const parsed = createCallResponseSchema.safeParse(await post('/v1/calls', signal, request));
      if (!parsed.success) throw new CallApiError('invalid_response');
      if (options.requireSecureMedia && !parsed.data.livekit.url.startsWith('wss://')) {
        throw new CallApiError('invalid_response');
      }
      return parsed.data;
    },
    async end(callId, signal) {
      await post(`/v1/calls/${encodeURIComponent(callId)}/end`, signal);
    },
  };
}
