import type { DeviceInfoMessage } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { DeviceReporter } from './device-report';

function reporter() {
  const sent: DeviceInfoMessage[] = [];
  const r = new DeviceReporter(
    { platform: 'android', os: '14', model: 'Pixel 7', appBuild: '29' },
    (info) => sent.push(info),
  );
  return { r, sent };
}

describe('DeviceReporter', () => {
  it('sends nothing until the call is live, then sends device and route on start', () => {
    const { r, sent } = reporter();
    r.update('PREPARING', undefined);
    r.update('CONNECTING', 'speaker');
    expect(sent).toEqual([]);
    r.update('LISTENING', 'speaker');
    expect(sent).toEqual([
      {
        v: 1,
        type: 'device_info',
        route: 'speaker',
        platform: 'android',
        os: '14',
        model: 'Pixel 7',
        app_build: '29',
      },
    ]);
  });

  it('sends again on each route change, never twice for the same route', () => {
    const { r, sent } = reporter();
    r.update('LISTENING', undefined);
    r.update('USER_SPEAKING', undefined);
    r.update('USER_SPEAKING', 'speaker');
    r.update('AGENT_SPEAKING', 'speaker');
    // While the room reconnects nothing can be delivered; the new route goes once it is back.
    r.update('RECONNECTING', 'bluetooth');
    expect(sent.map((m) => m.route)).toEqual(['unknown', 'speaker']);
    r.update('LISTENING', 'bluetooth');
    expect(sent.map((m) => m.route)).toEqual(['unknown', 'speaker', 'bluetooth']);
  });

  it('starts over for the next call', () => {
    const { r, sent } = reporter();
    r.update('LISTENING', 'earpiece');
    r.update('ENDED', 'earpiece');
    r.update('CONNECTING', 'earpiece');
    expect(sent).toHaveLength(1);
    r.update('LISTENING', 'earpiece');
    expect(sent).toHaveLength(2);
  });

  it('omits facts the platform does not give', () => {
    const sent: DeviceInfoMessage[] = [];
    new DeviceReporter({}, (info) => sent.push(info)).update('LISTENING', 'headset');
    expect(sent).toEqual([{ v: 1, type: 'device_info', route: 'headset' }]);
  });

  it('resends the current route once after the room reconnects', () => {
    const { r, sent } = reporter();
    r.update('LISTENING', 'speaker');
    r.update('RECONNECTING', 'speaker');
    r.update('RECONNECTING', 'speaker');
    expect(sent).toHaveLength(1);
    r.update('LISTENING', 'speaker');
    r.update('AGENT_SPEAKING', 'speaker');
    expect(sent.map((m) => m.route)).toEqual(['speaker', 'speaker']);
  });

  it('a new call after an ended one reports again', () => {
    const { r, sent } = reporter();
    r.update('LISTENING', 'earpiece');
    r.update('ENDED', 'earpiece');
    r.update('CONNECTING', 'earpiece');
    expect(sent).toHaveLength(1);
    r.update('LISTENING', 'earpiece');
    expect(sent).toHaveLength(2);
  });
});
