import { describe, expect, it } from 'vitest';

import { SseLimitError, SseParser, type SseEvent } from './sse-parser';

const bytes = (text: string) => new TextEncoder().encode(text);

function parseAll(chunks: Uint8Array[], parser = new SseParser()): SseEvent[] {
  const events = chunks.flatMap((chunk) => parser.push(chunk));
  return [...events, ...parser.end()];
}

const parse = (text: string) => parseAll([bytes(text)]);

/** Splits `data` at `cuts` byte offsets. */
function splitAt(data: Uint8Array, cuts: number[]): Uint8Array[] {
  const sorted = [...new Set(cuts)].sort((a, b) => a - b);
  const parts: Uint8Array[] = [];
  let from = 0;
  for (const cut of sorted) {
    parts.push(data.slice(from, cut));
    from = cut;
  }
  parts.push(data.slice(from));
  return parts;
}

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('SseParser', () => {
  it('parses event, data, and id fields and dispatches on a blank line', () => {
    expect(parse('event: text.delta\nid: 7\ndata: {"a":1}\n\n')).toEqual([
      { type: 'text.delta', data: '{"a":1}', lastEventId: '7', hasId: true },
    ]);
  });

  it('defaults the type to message and joins multi-line data with LF', () => {
    expect(parse('data: one\ndata: two\ndata\n\n')).toEqual([
      { type: 'message', data: 'one\ntwo\n', lastEventId: '', hasId: false },
    ]);
  });

  it('strips exactly one space after the colon', () => {
    expect(parse('data:  two spaces\n\ndata:none\n\n').map((e) => e.data)).toEqual([
      ' two spaces',
      'none',
    ]);
  });

  it('accepts LF, CRLF, and CR line endings, mixed', () => {
    const events = parse('data: a\r\n\r\ndata: b\r\rdata: c\n\ndata: d\r\n\n');
    expect(events.map((e) => e.data)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ignores comments, unknown fields, and blocks without data', () => {
    const events = parse(': heartbeat\n\nevent: x\n\nfoo: bar\ndata: y\n\n:\n\n');
    expect(events).toEqual([{ type: 'message', data: 'y', lastEventId: '', hasId: false }]);
  });

  it('dispatches an event with empty data for a bare data line', () => {
    expect(parse('data:\n\n')).toEqual([
      { type: 'message', data: '', lastEventId: '', hasId: false },
    ]);
  });

  it('keeps the last event id across events but reports whether each block set it', () => {
    const events = parse('id: 1\ndata: a\n\ndata: b\n\nid\ndata: c\n\n');
    expect(events.map((e) => [e.lastEventId, e.hasId])).toEqual([
      ['1', true],
      ['1', false],
      ['', true],
    ]);
  });

  it('ignores an id containing NUL', () => {
    const events = parse('id: 1\ndata: a\n\nid: x\u0000y\ndata: b\n\n');
    expect(events.map((e) => e.lastEventId)).toEqual(['1', '1']);
  });

  it('records retry only for all-digit values', () => {
    const parser = new SseParser();
    parseAll([bytes('retry: 1500\n\nretry: 2x\n\n')], parser);
    expect(parser.retryMs).toBe(1500);
  });

  it('strips one leading BOM, even split across chunks, and only at the start', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const body = bytes('data: a\n\n');
    const events = parseAll([bom.slice(0, 1), bom.slice(1), body]);
    expect(events.map((e) => e.data)).toEqual(['a']);
    // A second BOM is part of the line: here it makes the field name unknown.
    expect(parseAll([bom, bom, body])).toEqual([]);
  });

  it('discards an unterminated event at end of stream', () => {
    expect(parse('data: done\n\ndata: partial\n')).toHaveLength(1);
    expect(parse('data: done\n\ndata: partial')).toHaveLength(1);
  });

  it('end() reports whether it discarded a partial line or event', () => {
    const clean = new SseParser();
    clean.push(bytes('data: a\n\n'));
    clean.end();
    expect(clean.truncated).toBe(false);
    for (const tail of ['data: partial', 'data: partial\n']) {
      const cut = new SseParser();
      cut.push(bytes(`data: a\n\n${tail}`));
      expect(cut.end()).toEqual([]);
      expect(cut.truncated).toBe(true);
    }
  });

  it('handles CRLF split across chunks without producing a blank line', () => {
    const events = parseAll([bytes('data: a\r'), bytes('\ndata: b\r'), bytes('\n\r'), bytes('\n')]);
    expect(events.map((e) => e.data)).toEqual(['a\nb']);
  });

  it('decodes multi-byte UTF-8 split mid code point', () => {
    const text = 'data: héllo: 😀 ✓\n\n';
    const data = bytes(text);
    for (let cut = 1; cut < data.length; cut += 1) {
      expect(parseAll(splitAt(data, [cut])).map((e) => e.data)).toEqual(['héllo: 😀 ✓']);
    }
  });

  it('gives the same result for every random chunking of a realistic stream', () => {
    const stream =
        '\uFEFF: open\r\n\r\n' +
        'event: run.started\nid: e1\ndata: {}\n\n' +
        'event: text.delta\r\nid: e2\r\ndata: {"delta":"naïve ',
      tail =
        'café 😀"}\r\n\r\n: hb\r\rretry: 10\nevent: done\rdata: {"status":\ndata: "completed"}\r\r';
    const data = bytes(stream + tail);
    const expected = parseAll([data]);
    expect(expected.map((e) => e.type)).toEqual(['run.started', 'text.delta', 'done']);
    expect(expected[1]?.data).toBe('{"delta":"naïve café 😀"}');
    expect(expected[2]?.data).toBe('{"status":\n"completed"}');
    const random = rng(42);
    for (let round = 0; round < 500; round += 1) {
      const cuts = Array.from({ length: 1 + Math.floor(random() * 12) }, () =>
        Math.floor(random() * data.length),
      );
      expect(parseAll(splitAt(data, cuts))).toEqual(expected);
    }
    // One byte at a time.
    expect(parseAll(Array.from(data, (b) => new Uint8Array([b])))).toEqual(expected);
  });

  it('throws SseLimitError when one event’s data exceeds the limit', () => {
    const parser = new SseParser({ maxEventBytes: 10 });
    expect(parser.push(bytes('data: 12345\n\n'))).toHaveLength(1);
    expect(() => parser.push(bytes('data: 123456\ndata: 1234\n'))).toThrow(SseLimitError);
  });

  it('throws SseLimitError for an unterminated line longer than the limit', () => {
    const parser = new SseParser({ maxEventBytes: 16 });
    expect(() => parser.push(bytes(`data: ${'x'.repeat(100)}`))).toThrow(SseLimitError);
  });

  it('counts UTF-8 bytes, not characters, against the data limit', () => {
    const parser = new SseParser({ maxEventBytes: 8 });
    expect(() => parser.push(bytes('data: ééééé\n'))).toThrow(SseLimitError);
  });
});
