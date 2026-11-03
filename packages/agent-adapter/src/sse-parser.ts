/**
 * An incremental `text/event-stream` parser following the WHATWG HTML "server-sent events"
 * interpretation rules: UTF-8 decoding with a leading BOM stripped, LF / CRLF / CR line endings,
 * `event` / `data` (multi-line) / `id` / `retry` fields, `:` comments, and dispatch on a blank line.
 * Chunks may be split anywhere, including inside a line ending or a multi-byte UTF-8 code point.
 */

export interface SseEvent {
  /** The `event:` field, or `message` when the block had none. */
  type: string;
  /** Every `data:` line of the block, joined with `\n`. */
  data: string;
  /** The last event ID buffer at dispatch time (it persists across events, per the standard). */
  lastEventId: string;
  /** True when this block itself carried an `id:` field. */
  hasId: boolean;
}

export class SseLimitError extends Error {
  override readonly name = 'SseLimitError';
  constructor() {
    super('SSE event exceeds the size limit');
  }
}

export interface SseParserOptions {
  /**
   * Largest `data` (UTF-8 bytes) of one event. An unterminated line may grow to this plus
   * `LINE_HEADROOM_BYTES` (for the field name, colon, and space), measured in UTF-8 bytes like the
   * data, so the verdict never depends on how the line was chunked. Exceeding either throws
   * `SseLimitError` so a hostile stream cannot grow memory without bound.
   */
  maxEventBytes?: number;
}

const DEFAULT_MAX_EVENT_BYTES = 65_536;
/** Room on an unterminated line for `data: ` (or any field prefix) beyond the data limit. */
export const LINE_HEADROOM_BYTES = 64;

export class SseParser {
  /** The last `retry:` value the stream set, in milliseconds. */
  retryMs: number | undefined;
  private readonly decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  private readonly maxEventBytes: number;
  private line = '';
  /** UTF-8 bytes in `line`, kept incrementally so each push costs only its own chunk. */
  private lineBytes = 0;
  /** The last `end()` discarded an unterminated line or event (the stream was cut mid-event). */
  truncated = false;
  private sawFirstChar = false;
  /** The previous chunk ended in CR: a leading LF in the next chunk belongs to that line ending. */
  private skipLf = false;
  private eventType = '';
  private data = '';
  private dataBytes = 0;
  private hasData = false;
  private lastEventId = '';
  private blockHasId = false;

  constructor(options: SseParserOptions = {}) {
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  }

  /** Feeds raw bytes; returns every event completed by them, in order. */
  push(chunk: Uint8Array): SseEvent[] {
    return this.feed(this.decoder.decode(chunk, { stream: true }));
  }

  /**
   * The stream ended. Flushes the decoder and processes only complete lines; an unterminated line
   * or an event without its terminating blank line is discarded, as the standard requires (and
   * `truncated` says so). Never throws: the unterminated remainder is not length-checked.
   * Returns anything completed by the final bytes.
   */
  end(): SseEvent[] {
    let events: SseEvent[] = [];
    try {
      events = this.feed(this.decoder.decode(), false);
    } catch {
      // A complete final line over the data limit: the event is discarded like any partial one.
      this.hasData = true;
    }
    this.truncated = this.line !== '' || this.hasData;
    this.line = '';
    this.lineBytes = 0;
    this.resetBlock();
    return events;
  }

  private feed(text: string, checkLine = true): SseEvent[] {
    const events: SseEvent[] = [];
    let start = 0;
    if (!this.sawFirstChar && text.length > 0) {
      this.sawFirstChar = true;
      if (text.charCodeAt(0) === 0xfeff) start = 1;
    }
    for (let i = start; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (this.skipLf) {
        this.skipLf = false;
        if (code === 0x0a) {
          start = i + 1;
          continue;
        }
      }
      if (code !== 0x0a && code !== 0x0d) continue;
      this.line += text.slice(start, i);
      start = i + 1;
      if (code === 0x0d) this.skipLf = true;
      const event = this.processLine(this.line);
      this.line = '';
      this.lineBytes = 0;
      if (event !== undefined) events.push(event);
    }
    const rest = text.slice(start);
    this.line += rest;
    this.lineBytes += Buffer.byteLength(rest, 'utf8');
    if (checkLine && this.lineBytes > this.maxEventBytes + LINE_HEADROOM_BYTES) {
      throw new SseLimitError();
    }
    return events;
  }

  private processLine(line: string): SseEvent | undefined {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    let field = line;
    let value = '';
    if (colon >= 0) {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }
    switch (field) {
      case 'event':
        this.eventType = value;
        break;
      case 'data':
        this.dataBytes += Buffer.byteLength(value, 'utf8') + (this.hasData ? 1 : 0);
        if (this.dataBytes > this.maxEventBytes) throw new SseLimitError();
        this.data = this.hasData ? `${this.data}\n${value}` : value;
        this.hasData = true;
        break;
      case 'id':
        if (!value.includes('\0')) {
          this.lastEventId = value;
          this.blockHasId = true;
        }
        break;
      case 'retry':
        if (/^[0-9]+$/.test(value)) this.retryMs = Number(value);
        break;
      default:
        break;
    }
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    if (!this.hasData) {
      this.resetBlock();
      return undefined;
    }
    const event: SseEvent = {
      type: this.eventType === '' ? 'message' : this.eventType,
      data: this.data,
      lastEventId: this.lastEventId,
      hasId: this.blockHasId,
    };
    this.resetBlock();
    return event;
  }

  private resetBlock(): void {
    this.eventType = '';
    this.data = '';
    this.dataBytes = 0;
    this.hasData = false;
    this.blockHasId = false;
  }
}
