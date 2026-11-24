const WINDOW = 64n;
const FULL = (1n << WINDOW) - 1n;

/**
 * Private chats (ADR-044): per sender device, the highest seq seen and which of the 63 before it
 * were seen, so each sealed message opens once. Used by the computer and the phone alike.
 *
 * All chunks of one streamed reply share one seq, so a chunk index keeps its own window: the
 * replay key is (sender, seq, chunk index), and a message without chunks is apart from chunk 0.
 * Seeded with the highest seq per sender saved before a restart (all older ones count as seen,
 * for every chunk index).
 */
export class ReplayWindow {
  private readonly lanes = new Map<string, { highest: number; bits: bigint }>();
  /** The seq saved before a restart: a lane opened later starts there. */
  private readonly floor = new Map<string, number>();
  private readonly top = new Map<string, number>();

  constructor(saved: Record<string, number> = {}) {
    for (const [sender, highest] of Object.entries(saved)) {
      this.floor.set(sender, highest);
      this.top.set(sender, highest);
    }
  }

  private lane(sender: string, chunk: number | undefined) {
    const key = chunk === undefined ? sender : `${sender}#${chunk}`;
    let entry = this.lanes.get(key);
    if (entry === undefined) {
      const highest = this.floor.get(sender);
      if (highest === undefined) return { key, entry: undefined };
      entry = { highest, bits: FULL };
      this.lanes.set(key, entry);
    }
    return { key, entry };
  }

  /** Whether `accept` would take it; changes nothing. */
  fresh(sender: string, seq: number, chunk?: number): boolean {
    const key = chunk === undefined ? sender : `${sender}#${chunk}`;
    const entry = this.lanes.get(key);
    const highest = entry?.highest ?? this.floor.get(sender);
    if (highest === undefined || seq > highest) return true;
    const back = BigInt(highest - seq);
    const bits = entry?.bits ?? FULL;
    return back < WINDOW && (bits & (1n << back)) === 0n;
  }

  accept(sender: string, seq: number, chunk?: number): boolean {
    if (!this.fresh(sender, seq, chunk)) return false;
    const { key, entry } = this.lane(sender, chunk);
    if (entry === undefined) {
      this.lanes.set(key, { highest: seq, bits: 1n });
    } else if (seq > entry.highest) {
      const shift = BigInt(seq - entry.highest);
      entry.bits = shift >= WINDOW ? 1n : ((entry.bits << shift) | 1n) & FULL;
      entry.highest = seq;
    } else {
      entry.bits |= 1n << BigInt(entry.highest - seq);
    }
    const before = this.top.get(sender);
    if (before === undefined || seq > before) this.top.set(sender, seq);
    return true;
  }

  /** Highest seq per sender (over every chunk index), to save. */
  highest(): Record<string, number> {
    return Object.fromEntries(this.top);
  }
}
