import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { ChildLike, SpawnFn, SpawnRequest } from './process';

/** A scripted child process for adapter tests. Test code only. */
export class FakeChild extends EventEmitter implements ChildLike {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Every line the adapter wrote, parsed when JSON. */
  readonly written: unknown[] = [];
  stdinText = '';
  killed = false;
  private exited = false;

  constructor(readonly request: SpawnRequest) {
    super();
    let buffer = '';
    this.stdin.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.stdinText += text;
      buffer += text;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          this.written.push(JSON.parse(line));
        } catch {
          this.written.push(line);
        }
        this.emit('line', this.written.at(-1));
        newline = buffer.indexOf('\n');
      }
    });
  }

  /** Writes a stdout line (objects as JSON). */
  out(line: unknown): void {
    this.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
  }

  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    // Let buffered stdout lines reach the reader before the exit is seen.
    setTimeout(() => this.emit('exit', code), 5);
  }

  killTree(): void {
    this.killed = true;
    this.exit(null);
  }

  /** Resolves with the next written message matching `test`. */
  next(test: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const match = (m: unknown): m is Record<string, unknown> =>
      typeof m === 'object' && m !== null && test(m as Record<string, unknown>);
    const seen = this.written.find(match);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve) => {
      const onLine = (m: unknown) => {
        if (match(m)) {
          this.off('line', onLine);
          resolve(m);
        }
      };
      this.on('line', onLine);
    });
  }
}

export function fakeSpawner(): {
  spawn: SpawnFn;
  children: FakeChild[];
  spawned: Promise<FakeChild>[];
} {
  const children: FakeChild[] = [];
  const waiters: ((child: FakeChild) => void)[] = [];
  const spawned: Promise<FakeChild>[] = [];
  for (let i = 0; i < 10; i += 1) spawned.push(new Promise((resolve) => waiters.push(resolve)));
  return {
    children,
    spawned,
    spawn: (request) => {
      const child = new FakeChild(request);
      waiters[children.length]?.(child);
      children.push(child);
      return child;
    },
  };
}
