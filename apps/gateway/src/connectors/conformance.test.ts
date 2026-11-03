import {
  runAdapterConformance,
  type ConformanceScenario,
  type MakeConformanceHarness,
} from '@twring/agent-adapter/conformance';
import { MAX_NATIVE_MESSAGE_BYTES } from '@twring/contracts';

import { startConnectorGateway } from './harness';
import { ConnectorRelayAdapter } from './relay-adapter';
import { answerScript, type FakeConnectorOptions, type FakeConnectorScript } from './testing';

/** AGENT_ADAPTER_SPEC §18 run against a `cord-connector` agent: the relayed native protocol. */

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const ev = (turnId: string, n: number, body: Record<string, unknown>) => ({
  event_id: `evt_${n}`,
  turn_id: turnId,
  seq: n,
  ...body,
});
const frames =
  (build: (turnId: string) => Record<string, unknown>[]): FakeConnectorScript =>
  async (turn, ctx) => {
    for (const frame of build(turn.turn_id)) {
      ctx.send(frame);
      await tick();
    }
  };
const answer = (id: string, parts: string[]) => [
  ev(id, 1, { type: 'run.started' }),
  ev(id, 2, { type: 'text.start', message_id: 'm' }),
  ...parts.map((delta, i) => ev(id, 3 + i, { type: 'text.delta', message_id: 'm', delta })),
  ev(id, 3 + parts.length, { type: 'text.end', message_id: 'm' }),
  ev(id, 4 + parts.length, { type: 'done', status: 'completed' }),
];
const streamUntilCancelled: FakeConnectorScript = async (turn, ctx) => {
  const id = turn.turn_id;
  ctx.send(ev(id, 1, { type: 'run.started' }));
  ctx.send(ev(id, 2, { type: 'text.start', message_id: 'm' }));
  for (let n = 3; !ctx.signal.aborted && n < 500; n += 1) {
    ctx.send(ev(id, n, { type: 'text.delta', message_id: 'm', delta: 'word ' }));
    await tick();
  }
};
const dropAfterStart: FakeConnectorScript = async (turn, ctx) => {
  if (turn.turn_id === 't_drop' || turn.turn_id === 't_noresume') {
    ctx.send(ev(turn.turn_id, 1, { type: 'run.started' }));
    await tick();
    ctx.closeChannel();
    return;
  }
  await frames((id) => answer(id, ['Back ', 'again.']))(turn, ctx);
};

let supersedeTurns = 0;
const supersede: FakeConnectorScript = async (turn, ctx) => {
  supersedeTurns += 1;
  if (supersedeTurns > 1) return frames((id) => answer(id, ['Next ', 'answer.']))(turn, ctx);
  return streamUntilCancelled(turn, ctx);
};

const SCENARIOS: Record<
  ConformanceScenario,
  { connector?: Partial<FakeConnectorOptions>; handshakeMs?: number }
> = {
  streamed: { connector: { script: answerScript } },
  single_final: { connector: { script: frames((id) => answer(id, ['All in one reply.'])) } },
  empty: {
    connector: {
      script: frames((id) => [
        ev(id, 1, { type: 'run.started' }),
        ev(id, 2, { type: 'done', status: 'completed' }),
      ]),
    },
  },
  auth_failure: { connector: { handshake: 'auth_failed' } },
  timeout: { connector: { handshake: 'silent' }, handshakeMs: 100 },
  malformed: {
    connector: {
      script: frames((id) => [
        ev(id, 1, { type: 'run.started' }),
        { type: 'text.delta', turn_id: id },
      ]),
    },
  },
  oversized: {
    connector: {
      script: frames((id) => [
        ev(id, 1, { type: 'run.started' }),
        ev(id, 2, {
          type: 'activity',
          label: 'x',
          pad: 'y'.repeat(MAX_NATIVE_MESSAGE_BYTES + 100),
        }),
      ]),
    },
  },
  duplicate: {
    connector: {
      script: frames((id) => {
        const [start, textStart, delta, ...rest] = answer(id, ['Once.']);
        return [start!, textStart!, delta!, delta!, ...rest];
      }),
    },
  },
  out_of_order: {
    connector: {
      script: frames((id) => [
        ev(id, 1, { type: 'run.started' }),
        ev(id, 3, { type: 'text.start', message_id: 'm' }),
        ev(id, 2, { type: 'text.delta', message_id: 'm', delta: 'late' }),
      ]),
    },
  },
  cancellation: { connector: { script: streamUntilCancelled } },
  supersede: { connector: { script: supersede } },
  late_after_done: {
    connector: {
      script: frames((id) => [
        ...answer(id, ['Done.']),
        ev(id, 50, { type: 'text.delta', message_id: 'm', delta: 'ghost' }),
      ]),
    },
  },
  disconnect: { connector: { script: dropAfterStart } },
  resume_not_declared: {
    connector: {
      script: dropAfterStart,
      capabilities: { streaming_text: true, cancel: true, resume: false },
    },
  },
};

const makeHarness: MakeConformanceHarness = async (scenario) => {
  supersedeTurns = 0;
  const config = SCENARIOS[scenario];
  const g = await startConnectorGateway();
  const { connectorId, connector } = await g.connect('alice', config.connector);
  const adapter = new ConnectorRelayAdapter(
    g.hub,
    'alice',
    { connectorId, localAgent: 'claude-code' },
    { handshakeMs: config.handshakeMs ?? 2_000 },
  );
  return {
    adapter,
    receivedTurns: () =>
      connector.received.flatMap((r) =>
        r.message.type === 'user.turn' ? [r.message.turn_id] : [],
      ),
    receivedCancels: () =>
      connector.received.flatMap((r) =>
        r.message.type === 'turn.cancel' ? [r.message.turn_id] : [],
      ),
    dispose: () => g.close(),
  };
};

runAdapterConformance('ConnectorRelayAdapter', makeHarness);
