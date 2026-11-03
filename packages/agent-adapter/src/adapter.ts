import type {
  AdapterCapabilities,
  AgentEvent,
  TurnCancelReason,
  UserTurn,
} from '@twring/contracts';

export interface AgentConnectionContext {
  callId: string;
  sessionId: string;
}

/**
 * Twring's boundary with a connected agent (AGENT_ADAPTER_SPEC §2). The agent keeps its own
 * reasoning, memory, and tools; an adapter only carries user turns in and normalized events out.
 */
export interface TwringAgentAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  connect(context: AgentConnectionContext, signal: AbortSignal): Promise<void>;
  /**
   * Sends one committed turn and streams the agent's events for it. Aborting `signal` stops the
   * stream; it does not undo anything the agent already did.
   */
  sendTurn(turn: UserTurn, signal: AbortSignal): AsyncIterable<AgentEvent>;
  /** Asks the agent to stop working on `turnId`, when it supports that. */
  cancelTurn?(turnId: string, reason: TurnCancelReason): Promise<void>;
  decideApproval?(turnId: string, approvalId: string, decision: 'approve' | 'deny'): Promise<void>;
  close(): Promise<void>;
}

/** Waits `ms`, or rejects with the signal's reason once it aborts. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const systemSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = () => {
      clearTimeout(handle);
      reject(signal.reason as Error);
    };
    const handle = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
