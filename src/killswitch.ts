/**
 * Out-of-band runtime control: quarantines a node once its integrity
 * violations cross a threshold.
 *
 * Deliberately not part of the consensus computation. If it lived inside
 * the same code path as consensus, a bug or compromise in that path could
 * take the breaker down with it — the whole point of an out-of-band
 * breaker is that it doesn't depend on the correctness of the thing it's
 * watching. It only sees the pass/fail integrity outcome the swarm layer
 * reports to it, and it decides quarantine independently of any vote.
 */
export interface ViolationResult {
  readonly nodeId: string;
  readonly count: number;
  readonly tripped: boolean;
}

export class KillSwitch {
  private readonly violations = new Map<string, number>();
  private readonly quarantined = new Set<string>();

  constructor(private readonly threshold: number) {
    if (threshold < 1) throw new Error('threshold must be at least 1');
  }

  isQuarantined(nodeId: string): boolean {
    return this.quarantined.has(nodeId);
  }

  /** Record one integrity violation for `nodeId`. Quarantines it once `threshold` is reached. */
  recordViolation(nodeId: string): ViolationResult {
    const count = (this.violations.get(nodeId) ?? 0) + 1;
    this.violations.set(nodeId, count);

    const alreadyQuarantined = this.quarantined.has(nodeId);
    const tripped = !alreadyQuarantined && count >= this.threshold;
    if (tripped) this.quarantined.add(nodeId);

    return { nodeId, count, tripped };
  }

  quarantinedNodes(): readonly string[] {
    return [...this.quarantined];
  }
}
