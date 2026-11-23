/**
 * Caller audio held while the hearing (STT) socket reconnects, so words spoken during the gap
 * reach the new session instead of being lost. A fixed ring: it allocates once, keeps the newest
 * `capacity` samples, and counts what it had to drop.
 */
export class SttBacklog {
  private readonly ring: Int16Array;
  private start = 0;
  private length = 0;
  /** Samples pushed out by newer audio, over the backlog's life. */
  droppedSamples = 0;

  constructor(capacity: number) {
    this.ring = new Int16Array(capacity);
  }

  get size(): number {
    return this.length;
  }

  push(samples: Int16Array): void {
    const capacity = this.ring.length;
    let input = samples;
    if (input.length > capacity) {
      this.droppedSamples += input.length - capacity;
      input = input.subarray(input.length - capacity);
    }
    const overflow = this.length + input.length - capacity;
    if (overflow > 0) {
      this.droppedSamples += overflow;
      this.start = (this.start + overflow) % capacity;
      this.length -= overflow;
    }
    let write = (this.start + this.length) % capacity;
    let offset = 0;
    while (offset < input.length) {
      const take = Math.min(input.length - offset, capacity - write);
      this.ring.set(input.subarray(offset, offset + take), write);
      offset += take;
      write = (write + take) % capacity;
    }
    this.length += input.length;
  }

  /** Hands the held audio to `send` oldest first (as views into the ring), then empties. */
  drain(send: (samples: Int16Array) => void): void {
    const capacity = this.ring.length;
    const first = Math.min(this.length, capacity - this.start);
    if (first > 0) send(this.ring.subarray(this.start, this.start + first));
    if (this.length > first) send(this.ring.subarray(0, this.length - first));
    this.clear();
  }

  clear(): void {
    this.start = 0;
    this.length = 0;
  }
}
