import { describe, expect, it } from 'vitest';

import { SseLimitError, SseParser, type SseEvent } from './sse-parser';

// Verifier edge cases for the WHATWG event-stream parser (Milestone 6).

const bytes = (text: string) => new TextEncoder().encode(text);

function parseChunks(chunks: string[], parser = new SseParser()): SseEvent[] {
  const events = chunks.flatMap((chunk) => parser.push(bytes(chunk)));
  return [...events, ...parser.end()];
}

describe('SseParser edge cases', () => {
  it('a CR ending one chunk and a CR starting the next are two line endings (blank line)', () => {
    expect(parseChunks(['data: x\r', '\r'])).toEqual([
      { type: 'message', data: 'x', lastEventId: '', hasId: false },
    ]);
  });

  it('a lone CR at a chunk end followed by a field starts a new line', () => {
    expect(parseChunks(['data: a\r', 'data: b\r\r'])).toEqual([
      { type: 'message', data: 'a\nb', lastEventId: '', hasId: false },
    ]);
  });

  it('CRLF split into CR | LF | CRLF across three chunks is exactly one blank line', () => {
    expect(parseChunks(['data: a\r', '\n', '\r\n'])).toEqual([
      { type: 'message', data: 'a', lastEventId: '', hasId: false },
    ]);
  });

  it('field names are case-sensitive, a lone ":" is a comment, and data without a colon is empty', () => {
    expect(parseChunks(['Data: no\n:\ndata\ndata:x\n\n'])).toEqual([
      { type: 'message', data: '\nx', lastEventId: '', hasId: false },
    ]);
  });

  it('empty chunks are harmless, even before the BOM', () => {
    const parser = new SseParser();
    expect(parser.push(new Uint8Array())).toEqual([]);
    const events = parseChunks(['\uFEFFdata: 1\n\n'], parser);
    expect(events).toEqual([{ type: 'message', data: '1', lastEventId: '', hasId: false }]);
  });

  it('a second BOM mid-stream is data, not stripped', () => {
    expect(parseChunks(['\uFEFFdata: 1\n\n', '\uFEFFdata: 2\n\n'])).toEqual([
      { type: 'message', data: '1', lastEventId: '', hasId: false },
    ]);
  });

  it('an id block without data updates the last event id for the next event', () => {
    expect(parseChunks(['id: 5\n\ndata: x\n\n'])).toEqual([
      { type: 'message', data: 'x', lastEventId: '5', hasId: false },
    ]);
  });

  it('an empty id resets the last event id', () => {
    const events = parseChunks(['id: 5\ndata: a\n\nid\ndata: b\n\n']);
    expect(events.map((e) => [e.lastEventId, e.hasId])).toEqual([
      ['5', true],
      ['', true],
    ]);
  });

  it('retry with a leading space, and a non-numeric retry keeps the previous value', () => {
    const parser = new SseParser();
    parseChunks(['retry: 100\n', 'retry: 1e3\n', 'retry: -5\n\n'], parser);
    expect(parser.retryMs).toBe(100);
  });

  it('many small data lines are bounded by the event limit, counting the joining LFs', () => {
    const parser = new SseParser({ maxEventBytes: 10 });
    // 5 lines of 1 byte + 4 LFs = 9 bytes: fine. 6 lines = 11 bytes: over.
    expect(parseChunks(['data:a\n'.repeat(5) + '\n'], parser)).toHaveLength(1);
    expect(() => new SseParser({ maxEventBytes: 10 }).push(bytes('data:a\n'.repeat(6)))).toThrow(
      SseLimitError,
    );
  });

  it('the data limit resets per event', () => {
    const parser = new SseParser({ maxEventBytes: 8 });
    const events = parseChunks(['data: 12345678\n\n', 'data: 12345678\n\n'], parser);
    expect(events.map((e) => e.data)).toEqual(['12345678', '12345678']);
  });

  it('an unterminated huge line is bounded while it streams in (memory)', () => {
    const parser = new SseParser({ maxEventBytes: 1000 });
    parser.push(bytes('data: '));
    let thrown: unknown;
    try {
      for (let i = 0; i < 100; i += 1) parser.push(bytes('x'.repeat(100)));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SseLimitError);
  });

  // BUG (chunking-dependent limit): the unterminated-line check counts the whole line, including
  // the `data: ` prefix, in UTF-16 units; the data check counts only the value in bytes. So an
  // event whose data is at (or just under) the limit is accepted when its line arrives in one
  // chunk but rejected when TCP splits it, which it nearly always will for a 64 KiB line.
  it('an event with data exactly at the limit is accepted however the line is chunked', () => {
    const max = 1000;
    const line = `data: ${'x'.repeat(max)}\n\n`;
    const whole = parseChunks([line], new SseParser({ maxEventBytes: max }));
    expect(whole.map((e) => e.data.length)).toEqual([max]);
    const split = () =>
      parseChunks(
        [line.slice(0, max + 3), line.slice(max + 3)],
        new SseParser({ maxEventBytes: max }),
      );
    expect(split).not.toThrow();
  });

  // BUG (end() can throw): after a push leaves an unterminated line of exactly `max` characters
  // with an incomplete UTF-8 sequence pending in the decoder, end() flushes U+FFFD onto the line
  // and the length check throws. end() is documented as discarding the unterminated event, and
  // RestSseAdapter calls it from a response 'end' listener without a try/catch.
  it('end() never throws: an unterminated line is discarded, even with a partial code point', () => {
    const max = 1000;
    const parser = new SseParser({ maxEventBytes: max });
    const head = bytes('x'.repeat(max));
    const chunk = new Uint8Array(head.length + 1);
    chunk.set(head);
    chunk[head.length] = 0xe2; // first byte of a 3-byte sequence
    expect(parser.push(chunk)).toEqual([]);
    expect(() => parser.end()).not.toThrow();
  });
});
