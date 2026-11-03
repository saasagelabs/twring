import type { CallErrorCode } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_MAX_CHARS,
  activityText,
  formatDuration,
  meterLevel,
  noticeText,
  statusLabel,
} from './labels';

describe('call labels', () => {
  it('explains every notice in plain words', () => {
    expect(noticeText('agent_not_streaming')).toBe(
      "This agent doesn't stream, so replies may take longer.",
    );
    expect(noticeText('agent_unreachable')).toBe(
      "Couldn't reach your agent. Try again in a moment.",
    );
    for (const code of [
      'agent_failed',
      'agent_timeout',
      'agent_not_streaming',
      'agent_unreachable',
    ] as const) {
      expect(noticeText(code)).not.toMatch(/stream_|sse|http|json/i);
    }
  });

  it('never shows Connected before LISTENING', () => {
    expect(
      statusLabel({
        status: 'CONNECTING',
        callId: 'c',
        readiness: { media: true, gateway: false },
      }),
    ).toBe('Connecting…');
    expect(statusLabel({ status: 'LISTENING', callId: 'c' })).toBe('Listening');
  });

  it('says the agent is working, with its own activity label on the line below', () => {
    const working = (activity?: string) =>
      ({
        status: 'AGENT_WORKING',
        callId: 'c',
        turnId: 't',
        ...(activity !== undefined && { activity }),
      }) as const;
    expect(statusLabel({ status: 'USER_SPEAKING', callId: 'c' })).toBe('Listening');
    expect(statusLabel(working())).toBe('Working…');
    expect(statusLabel(working('Searching…'))).toBe('Working…');
    expect(activityText(working())).toBeUndefined();
    expect(activityText(working('Searching…'))).toBe('Searching…');
    expect(activityText(working('  Checking\ncalendar…  '))).toBe('Checking calendar…');
    expect(activityText(working('Reviewing <deployment>'))).toBe('Reviewing deployment');
  });

  it('never shows raw tool names, markup, or overlong activity labels', () => {
    const working = (activity: string) =>
      ({ status: 'AGENT_WORKING', callId: 'c', turnId: 't', activity }) as const;
    for (const raw of [
      'search_web',
      'calendar.list_events',
      'getWeather',
      'fetch(url)',
      'Working…',
    ]) {
      expect(activityText(working(raw))).toBeUndefined();
    }
    expect(activityText(working('**Searching**'))).toBe('Searching');
    const long = activityText(
      working('Reviewing the latest deployment logs for the production cluster today'),
    );
    expect(long!.length).toBeLessThanOrEqual(ACTIVITY_MAX_CHARS);
    expect(long).toMatch(/…$/);
    expect(long).not.toMatch(/\s…$/);
    expect(activityText({ status: 'LISTENING', callId: 'c' })).toBeUndefined();
    expect(statusLabel({ status: 'AGENT_SPEAKING', callId: 'c', turnId: 't' })).toBe('Speaking');
  });

  describe('activity text (milestone 9 verifier)', () => {
    const working = (activity: string) =>
      ({ status: 'AGENT_WORKING', callId: 'c', turnId: 't', activity }) as const;
    const cp = (...points: number[]) => String.fromCodePoint(...points);

    it('strips C1 controls, bidi controls, and line separators, not only C0', () => {
      // NEL, CSI, RLO, RLI/PDI, RLM, LINE SEPARATOR, ZWSP, BOM
      for (const point of [0x85, 0x9b, 0x202e, 0x2067, 0x200f, 0x2028, 0x200b, 0xfeff]) {
        const text = activityText(working(`Checking${cp(point)}calendar`));
        expect(text, point.toString(16)).toBe('Checking calendar');
      }
      const spoofed = activityText(working(`Paying ${cp(0x202e)}001$ ${cp(0x202c)}now`));
      expect(spoofed).toBe('Paying 001$ now');
    });

    it('never cuts a long label inside a surrogate pair', () => {
      const long = `${'a'.repeat(ACTIVITY_MAX_CHARS - 2)}${cp(0x1f600)}${'b'.repeat(10)}`;
      const text = activityText(working(long))!;
      expect(text.endsWith('…')).toBe(true);
      expect(text.isWellFormed()).toBe(true);
      expect(Array.from(text).length).toBeLessThanOrEqual(ACTIVITY_MAX_CHARS);
    });

    it('keeps non-Latin labels and emoji whole when they fit', () => {
      expect(activityText(working('தேடுகிறது…'))).toBe('தேடுகிறது…');
      expect(activityText(working(`Checking the weather ${cp(0x2600, 0xfe0f)}`))).toBe(
        `Checking the weather ${cp(0x2600, 0xfe0f)}`,
      );
    });

    it('drops labels that are empty after cleaning', () => {
      expect(activityText(working(`${cp(0x202e)}  ${cp(0x85)}<>**`))).toBeUndefined();
    });
  });

  it("says a failed call didn't connect when it never got going, else that it was interrupted", () => {
    const failed = (code: CallErrorCode) =>
      ({
        status: 'FAILED',
        callId: 'c',
        error: { code, message: 'x', retryable: true },
      }) as const;
    expect(statusLabel(failed('VOICE_UNAVAILABLE'))).toBe("Call didn't connect");
    expect(statusLabel(failed('NETWORK_LOST'))).toBe("Call didn't connect");
    expect(statusLabel(failed('VOICE_UNAVAILABLE'), 1_000)).toBe('Call interrupted');
    expect(statusLabel(failed('NETWORK_LOST'), 1_000)).toBe('Call interrupted');
    for (const code of [
      'CALL_SESSION_CREATE_FAILED',
      'LIVEKIT_CONNECT_FAILED',
      'GATEWAY_UNAVAILABLE',
      'AGENT_CONNECT_FAILED',
      'MIC_PERMISSION_DENIED',
      'MIC_UNAVAILABLE',
    ] as const) {
      expect(statusLabel(failed(code), 1_000)).toBe("Call didn't connect");
    }
  });

  it('formats call durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(194_900)).toBe('3:14');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
  });

  it('maps levels onto the meter range', () => {
    expect(meterLevel(-120)).toBe(0);
    expect(meterLevel(-30)).toBe(0.5);
    expect(meterLevel(0)).toBe(1);
  });
});
