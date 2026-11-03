import { adapterErrorCodeSchema, type AdapterErrorCode } from '@twring/contracts';

const SAFE_MESSAGES: Record<AdapterErrorCode, string> = {
  auth_failed: 'The agent rejected the credentials. Check the token and try again.',
  timeout: 'The agent did not answer in time.',
  protocol_unsupported: 'The agent speaks a protocol version Twring does not support.',
  protocol_violation: 'The agent sent a message Twring could not accept.',
  connection_failed: 'Twring could not reach the agent.',
  connection_lost: 'The connection to the agent dropped.',
  endpoint_rejected: 'That agent address is not allowed.',
  not_connected: 'Twring is not connected to the agent.',
  agent_error: 'The agent reported an error.',
  agent_offline: "Your computer isn't connected. Start cord-connect on it.",
  agent_not_on_computer: "This agent isn't set up on your computer anymore.",
};

const RETRYABLE: ReadonlySet<AdapterErrorCode> = new Set([
  'timeout',
  'connection_failed',
  'connection_lost',
]);

/**
 * A typed adapter failure. `message` is always Twring's own human-safe text: never agent-provided
 * text, URLs, headers, or credentials. `agentCode` carries an agent's own `session.error` code
 * (bounded by the contract schema) for diagnostics when it isn't one of Twring's codes.
 */
export class AdapterError extends Error {
  override readonly name = 'AdapterError';
  readonly retryable: boolean;
  readonly agentCode: string | undefined;
  /** The HTTP status that caused it, for request-per-turn adapters (REST). */
  readonly httpStatus: number | undefined;

  constructor(
    readonly code: AdapterErrorCode,
    options: { retryable?: boolean; agentCode?: string; detail?: string; httpStatus?: number } = {},
  ) {
    super(
      options.detail === undefined
        ? SAFE_MESSAGES[code]
        : `${SAFE_MESSAGES[code]} (${options.detail})`,
    );
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.agentCode = options.agentCode;
    this.httpStatus = options.httpStatus;
  }
}

export function isAdapterError(error: unknown): error is AdapterError {
  return error instanceof AdapterError;
}

/** Maps an agent's `session.error` code onto Twring's codes; unknown codes become `agent_error`. */
export function fromAgentCode(code: string): AdapterError {
  const parsed = adapterErrorCodeSchema.safeParse(code);
  return parsed.success
    ? new AdapterError(parsed.data)
    : new AdapterError('agent_error', { agentCode: code });
}
