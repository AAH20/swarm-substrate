/**
 * The shared wire format every layer in this stack composes against.
 *
 * A `SwarmEnvelope` is the one thing that flows through integrity checking,
 * gets signed and chained into the provenance ledger, and gets tallied by
 * consensus. Every layer reads/writes the same shape deliberately: that's
 * what makes this a composed stack instead of four unrelated modules that
 * happen to sit in the same repo.
 */

export type EnvelopeKind = 'proposal' | 'vote';

export interface SwarmEnvelope {
  readonly nodeId: string;
  readonly round: number;
  readonly kind: EnvelopeKind;
  /** The candidate action/value this node is proposing or voting for. */
  readonly value: string;
  /** Arbitrary tool/action payload attached to this envelope. Only this
   * field is subject to integrity checking — `value` is assumed to already
   * be a validated identifier (e.g. a hash), not attacker-controlled free
   * text. */
  readonly payload: unknown;
}
