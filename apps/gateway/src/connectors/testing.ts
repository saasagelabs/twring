import {
  NATIVE_PROTOCOL,
  nativeClientMessageSchema,
  RELAY_PROTOCOL,
  relayGatewayMessageSchema,
  type LocalAgent,
  type NativeClientMessage,
  type NativeSessionReady,
} from '@twring/contracts';
import WebSocket from 'ws';

/**
 * A scripted `cord-connect` for tests: pairs nothing itself (pass it a token), says hello, and
 * answers each channel as a `cord-agent/1` agent would. Test code only.
 */

type UserTurnMessage = Extract<NativeClientMessage, { type: 'user.turn' }>;

export interface FakeChannelContext {
  channel: string;
  agent: string;
  /** Aborted by `turn.cancel` for this turn, or when the channel or socket closes. */
  signal: AbortSignal;
  send(message: Record<string, unknown>): void;
  /** Closes this channel from the connector side, mid-turn. */
  closeChannel(): void;
}

export type FakeConnectorScript = (turn: UserTurnMessage, ctx: FakeChannelContext) => Promise<void>;

export interface FakeConnectorOptions {
  /** `ws://127.0.0.1:<port>/v1/connectors/socket` */
  url: string;
  token: string;
  agents?: LocalAgent[];
  script?: FakeConnectorScript;
  /** How a channel's `session.hello` is answered. */
  handshake?: 'ok' | 'silent' | 'auth_failed';
  capabilities?: NativeSessionReady['capabilities'];
  /** Sent in `connector.hello` (e.g. `scoped_sessions`); none, like an older computer. */
  features?: string[];
}

export interface FakeConnector {
  ws: WebSocket;
  /** Resolves on `connector.ready`, rejects if the socket closes first. */
  ready: Promise<void>;
  /** Every `cord-agent/1` message the gateway sent, per channel, in order. */
  received: { channel: string; message: NativeClientMessage }[];
  opened: {
    channel: string;
    agent: string;
    resume_ref?: string;
    fresh_session?: true;
    session_scope?: string;
  }[];
  /** Every `channel.open` frame exactly as the gateway sent it. */
  rawOpens: Record<string, unknown>[];
  closedByGateway: string[];
  /** The close code once the socket closed. */
  closed: Promise<number>;
  terminate(): void;
}

export const FAKE_AGENTS: LocalAgent[] = [
  { id: 'claude-code', label: 'Claude Code', kind: 'claude-code' },
  { id: 'gemini', label: 'Gemini CLI', kind: 'acp' },
];

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A short streamed answer. */
export const answerScript: FakeConnectorScript = async (turn, ctx) => {
  const id = turn.turn_id;
  let seq = 0;
  const ev = (body: Record<string, unknown>) => ({
    event_id: `evt_${id}_${seq}`,
    turn_id: id,
    seq: seq++,
    ...body,
  });
  for (const frame of [
    ev({ type: 'run.started' }),
    ev({ type: 'text.start', message_id: 'm' }),
    ev({ type: 'text.delta', message_id: 'm', delta: 'Hello ' }),
    ev({ type: 'text.delta', message_id: 'm', delta: 'from your computer.' }),
    ev({ type: 'text.end', message_id: 'm' }),
    ev({ type: 'done', status: 'completed' }),
  ]) {
    if (ctx.signal.aborted) return;
    ctx.send(frame);
    await tick();
  }
};

export function startFakeConnector(options: FakeConnectorOptions): FakeConnector {
  const ws = new WebSocket(options.url, {
    headers: { Authorization: `Bearer ${options.token}` },
  });
  const received: FakeConnector['received'] = [];
  const opened: FakeConnector['opened'] = [];
  const rawOpens: FakeConnector['rawOpens'] = [];
  const closedByGateway: string[] = [];
  const channels = new Map<string, { agent: string; turns: Map<string, AbortController> }>();
  const script = options.script ?? answerScript;

  const sendFrame = (frame: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  const abortChannel = (channel: string) => {
    for (const controller of channels.get(channel)?.turns.values() ?? []) controller.abort();
    channels.delete(channel);
  };

  let onReady!: () => void;
  let onFail!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    onReady = resolve;
    onFail = reject;
  });
  ready.catch(() => undefined);
  const closed = new Promise<number>((resolve) => {
    ws.on('close', (code) => {
      for (const channel of [...channels.keys()]) abortChannel(channel);
      onFail(new Error(`closed ${code}`));
      resolve(code);
    });
  });
  ws.on('error', (error) => onFail(error));
  ws.on('unexpected-response', (_req, res) => onFail(new Error(`HTTP ${res.statusCode}`)));
  ws.on('open', () => {
    sendFrame({
      type: 'connector.hello',
      protocol: RELAY_PROTOCOL,
      agent_protocol: NATIVE_PROTOCOL,
      agents: options.agents ?? FAKE_AGENTS,
      ...(options.features !== undefined && { features: options.features }),
    });
  });
  ws.on('message', (data: Buffer) => {
    const raw = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
    if (raw.type === 'channel.open') rawOpens.push(raw);
    const parsed = relayGatewayMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.type) {
      case 'connector.ready':
        onReady();
        return;
      case 'channel.open':
        opened.push({
          channel: frame.channel,
          agent: frame.agent,
          ...(frame.resume_ref !== undefined && { resume_ref: frame.resume_ref }),
          ...(frame.fresh_session === true && { fresh_session: true }),
          ...(frame.session_scope !== undefined && { session_scope: frame.session_scope }),
        });
        channels.set(frame.channel, { agent: frame.agent, turns: new Map() });
        return;
      case 'channel.close':
        closedByGateway.push(frame.channel);
        abortChannel(frame.channel);
        return;
      case 'channel.message': {
        const state = channels.get(frame.channel);
        const message = nativeClientMessageSchema.safeParse(frame.message);
        if (state === undefined || !message.success) return;
        received.push({ channel: frame.channel, message: message.data });
        const send = (inner: Record<string, unknown>) =>
          sendFrame({ type: 'channel.message', channel: frame.channel, message: inner });
        const m = message.data;
        switch (m.type) {
          case 'session.hello':
            if (options.handshake === 'silent') return;
            if (options.handshake === 'auth_failed') {
              send({ type: 'session.error', code: 'auth_failed' });
              return;
            }
            send({
              type: 'session.ready',
              protocol: NATIVE_PROTOCOL,
              capabilities: options.capabilities ?? {
                streaming_text: true,
                cancel: true,
                activity: true,
                tools: true,
              },
            });
            return;
          case 'ping':
            send({ type: 'pong', id: m.id });
            return;
          case 'approval.decision':
            return;
          case 'turn.cancel':
            state.turns.get(m.turn_id)?.abort();
            return;
          case 'user.turn': {
            const controller = new AbortController();
            state.turns.set(m.turn_id, controller);
            void script(m, {
              channel: frame.channel,
              agent: state.agent,
              signal: controller.signal,
              send,
              closeChannel: () => {
                sendFrame({ type: 'channel.close', channel: frame.channel });
                abortChannel(frame.channel);
              },
            })
              .catch(() => undefined)
              .finally(() => state.turns.delete(m.turn_id));
            return;
          }
        }
      }
    }
  });

  return {
    ws,
    ready,
    received,
    opened,
    rawOpens,
    closedByGateway,
    closed,
    terminate: () => ws.terminate(),
  };
}
