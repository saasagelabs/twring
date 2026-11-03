import {
  AdapterError,
  NativeWsAdapter,
  type AgentConnectionContext,
  type TwringAgentAdapter,
  type NativeWsTimeouts,
} from '@twring/agent-adapter';
import type {
  AdapterCapabilities,
  AgentEvent,
  ConnectorEndpoint,
  TurnCancelReason,
  UserTurn,
} from '@twring/contracts';
import type WebSocket from 'ws';

import type { ConnectorHub } from './hub';

/**
 * A `cord-connector` agent (ADR-023): `cord-agent/1` spoken through the user's own connector.
 * It is the ordinary `NativeWsAdapter` driving a relay channel instead of a network socket, so the
 * handshake, heartbeat, stream guard, cancel, and "a turn is sent exactly once" all carry over.
 * It can reach only a connector owned by `userId`; otherwise it reports `agent_offline`.
 */
export class ConnectorRelayAdapter implements TwringAgentAdapter {
  readonly name = 'cord-connector';
  private readonly inner: NativeWsAdapter;
  private freshSession = false;
  private resumeRef: string | undefined;

  constructor(
    private readonly hub: ConnectorHub,
    private readonly userId: string,
    private readonly endpoint: ConnectorEndpoint,
    timeouts: Partial<NativeWsTimeouts> = {},
    private readonly consumeFreshSession?: () => Promise<boolean>,
    /** Self-hosted shared agents: someone other than the owner, in their own session. */
    private readonly sessionScope?: string,
  ) {
    this.resumeRef = endpoint.resumeRef;
    this.inner = new NativeWsAdapter({
      url: `cord-connector://${endpoint.connectorId}/${endpoint.localAgent}`,
      socketFactory: () => {
        const freshSession = this.freshSession;
        this.freshSession = false;
        if (freshSession) this.resumeRef = undefined;
        return hub.socketFor(
          userId,
          endpoint.connectorId,
          endpoint.localAgent,
          this.resumeRef,
          freshSession,
          sessionScope,
        ) as unknown as WebSocket;
      },
      timeouts,
      // A channel is opened only while the computer is connected; retries would only wait.
      reconnectDelaysMs: [0],
    });
  }

  get capabilities(): AdapterCapabilities {
    // Only the owner approves actions on their own computer.
    return { ...this.inner.capabilities, approvals: this.sessionScope === undefined };
  }

  async connect(context: AgentConnectionContext, signal: AbortSignal): Promise<void> {
    const status = this.hub.agentStatus(
      this.userId,
      this.endpoint.connectorId,
      this.endpoint.localAgent,
    );
    if (status === 'offline') throw new AdapterError('agent_offline', { retryable: false });
    if (status === 'agent_missing') {
      throw new AdapterError('agent_not_on_computer', { retryable: false });
    }
    this.freshSession = (await this.consumeFreshSession?.()) ?? false;
    await this.inner.connect(context, signal);
  }

  sendTurn(turn: UserTurn, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const events = this.inner.sendTurn(turn, signal);
    return this.sessionScope === undefined ? events : this.denyApprovals(turn, events);
  }

  /**
   * Someone other than the owner never approves an action on the owner's computer: each request
   * is denied at once (the agent hears it was not approved) and never shown to them.
   */
  private async *denyApprovals(
    turn: UserTurn,
    events: AsyncIterable<AgentEvent>,
  ): AsyncIterable<AgentEvent> {
    for await (const event of events) {
      if (event.type === 'approval.required') {
        await this.inner.decideApproval(turn.turnId, event.approval_id, 'deny').catch(() => {
          // The turn goes on; an undecided request times out as denied on the computer.
        });
        continue;
      }
      if (event.type === 'approval.resolved') continue;
      yield event;
    }
  }

  cancelTurn(turnId: string, reason: TurnCancelReason): Promise<void> {
    return this.inner.cancelTurn(turnId, reason);
  }

  decideApproval(turnId: string, approvalId: string, decision: 'approve' | 'deny'): Promise<void> {
    if (this.sessionScope !== undefined) return Promise.resolve();
    return this.inner.decideApproval(turnId, approvalId, decision);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
