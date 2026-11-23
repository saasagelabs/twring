import { describe, expect, it } from 'vitest';

import { ALERT_WINDOW_MS, EventAlerts, WAVE_ONE_RULES } from './event-alerts';

function setup() {
  const clock = { ms: Date.parse('2026-10-22T10:00:00.000Z') };
  const sent: { subject: string; text: string }[] = [];
  const alerts = new EventAlerts({
    rules: WAVE_ONE_RULES,
    alert: (subject, text) => sent.push({ subject, text }),
    now: () => clock.ms,
  });
  return { alerts, sent, clock };
}

const INFO = 30;
const ERROR = 50;

describe('EventAlerts', () => {
  it('3 failed calls in 5 minutes alert once', () => {
    const t = setup();
    t.alerts.record(INFO, { event: 'call_failed' });
    t.alerts.record(INFO, { event: 'call_create_failed' });
    expect(t.sent).toEqual([]);
    t.alerts.record(INFO, { event: 'call_failed' });
    t.alerts.record(INFO, { event: 'call_failed' });
    expect(t.sent.map((s) => s.subject)).toEqual(['Twring: calls failing']);
    expect(t.sent[0]!.text).toContain('3 calls failed in 5 minutes');
  });

  it('counts start again in the next 5 minutes', () => {
    const t = setup();
    t.alerts.record(INFO, { event: 'call_failed' });
    t.alerts.record(INFO, { event: 'call_failed' });
    t.clock.ms += ALERT_WINDOW_MS;
    t.alerts.record(INFO, { event: 'call_failed' });
    expect(t.sent).toEqual([]);
  });

  it('push failures add up the failed count, and unreachable rings count too', () => {
    const t = setup();
    t.alerts.record(INFO, { event: 'push_sent', sent: 0, failed: 3 });
    t.alerts.record(INFO, { event: 'ring_unreachable' });
    expect(t.sent).toEqual([]);
    t.alerts.record(INFO, { event: 'push_sent', sent: 1, failed: 1 });
    expect(t.sent.map((s) => s.subject)).toEqual(['Twring: pushes failing']);
  });

  it('5 server errors alert; ordinary logs never do', () => {
    const t = setup();
    for (let n = 0; n < 50; n += 1) t.alerts.record(INFO, { event: 'call_ended' });
    for (let n = 0; n < 4; n += 1) t.alerts.record(ERROR, {});
    expect(t.sent).toEqual([]);
    t.alerts.record(ERROR, { msg: 'boom' });
    expect(t.sent.map((s) => s.subject)).toEqual(['Twring: server errors']);
  });

  it('6 computers dropping at once alert', () => {
    const t = setup();
    for (let n = 0; n < 6; n += 1) t.alerts.record(INFO, { event: 'connector_disconnected' });
    expect(t.sent.map((s) => s.subject)).toEqual(['Twring: computers dropping']);
  });

  it('ordinary churn (up to 5 different computers in 5 minutes) stays quiet', () => {
    const t = setup();
    for (const id of ['con_a', 'con_b', 'con_c', 'con_d', 'con_e'])
      t.alerts.record(INFO, { event: 'connector_disconnected', connector_id: id });
    expect(t.sent).toEqual([]);
  });

  it('after stop (the server is shutting down) nothing counts', () => {
    const t = setup();
    t.alerts.stop();
    for (let n = 0; n < 5; n += 1) t.alerts.record(INFO, { event: 'connector_disconnected' });
    expect(t.sent).toEqual([]);
  });

  it('odd log arguments never throw', () => {
    const t = setup();
    expect(() => {
      t.alerts.record(INFO, null);
      t.alerts.record(INFO, 'text');
      t.alerts.record(INFO, { event: 'push_sent', failed: 'x' });
    }).not.toThrow();
  });
});

describe('why computers dropped', () => {
  it('the alert says why, in plain words, most common first', () => {
    const t = setup();
    const reasons = ['no_pong', 'no_pong', 'closed', 'no_pong', 'revoked', 'closed'];
    reasons.forEach((reason, n) =>
      t.alerts.record(INFO, { event: 'connector_disconnected', connector_id: `con_${n}`, reason }),
    );
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.text).toContain(
      'Why: 3 stopped answering (a network stall), 2 closed by the computer, 1 removed by its owner.',
    );
  });

  it('lines without a reason (an older release) leave the reasons out', () => {
    const t = setup();
    for (let n = 0; n < 6; n += 1)
      t.alerts.record(INFO, { event: 'connector_disconnected', connector_id: `con_${n}` });
    expect(t.sent[0]!.text).not.toContain('Why:');
  });
});

describe('review fixes', () => {
  it('computers dropping counts different computers, not one flapping laptop', () => {
    const t = setup();
    for (let n = 0; n < 5; n += 1) {
      t.alerts.record(INFO, { event: 'connector_disconnected', connector_id: 'con_a' });
    }
    expect(t.sent).toEqual([]);
    for (const id of ['con_b', 'con_c', 'con_d', 'con_e', 'con_f'])
      t.alerts.record(INFO, { event: 'connector_disconnected', connector_id: id });
    expect(t.sent.map((s) => s.subject)).toEqual(['Twring: computers dropping']);
    expect(t.sent[0]!.text).toContain('6 computers');
  });
});
