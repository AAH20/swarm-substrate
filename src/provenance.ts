/**
 * Provenance layer: every envelope a node submits gets signed and
 * hash-chained via `pqattest`, whether or not it passes integrity.
 *
 * Attesting rejected envelopes too is deliberate, not an oversight: the
 * point of a provenance ledger is evidence of what was attempted, including
 * attacks that got caught, not just a record of successful actions. It's
 * also what consensus depends on structurally — every real Byzantine
 * agreement protocol requires votes to be attributable to a specific,
 * verifiable signer, or a faulty node could deny or fabricate its own vote
 * after the fact. This layer is what makes that attribution possible; it is
 * a precondition for consensus, not a parallel feature next to it.
 */
import {
  generateKeyPair,
  recordAction,
  verifyChain,
  type KeyPair,
  type AttestationEntry,
  type LedgerStore,
  type VerifyResult,
} from 'pqattest';
import type { SwarmEnvelope } from './schema.js';

export interface SwarmNode {
  readonly nodeId: string;
  readonly keyPair: KeyPair;
}

export function createNode(nodeId: string): SwarmNode {
  return { nodeId, keyPair: generateKeyPair() };
}

/** In-memory ledger store: per-actor append-only logs, ascending `seq`. */
export class InMemoryLedgerStore implements LedgerStore {
  private readonly entries = new Map<string, AttestationEntry[]>();

  async getLast(actorId: string): Promise<AttestationEntry | undefined> {
    const list = this.entries.get(actorId);
    return list?.[list.length - 1];
  }

  async append(entry: AttestationEntry): Promise<void> {
    const list = this.entries.get(entry.actorId) ?? [];
    list.push(entry);
    this.entries.set(entry.actorId, list);
  }

  async list(actorId: string): Promise<AttestationEntry[]> {
    return [...(this.entries.get(actorId) ?? [])];
  }
}

export interface AttestEnvelopeInput {
  readonly store: LedgerStore;
  readonly node: SwarmNode;
  readonly envelope: SwarmEnvelope;
  /** `undefined` for a clean envelope; the violation reason if integrity rejected it. */
  readonly integrityViolation: string | undefined;
}

/** Sign and chain one envelope into its node's ledger. Always attests — see module docs. */
export async function attestEnvelope(input: AttestEnvelopeInput): Promise<AttestationEntry> {
  const actionType = input.integrityViolation ? `${input.envelope.kind}:rejected` : input.envelope.kind;
  const summary = input.integrityViolation
    ? `round ${input.envelope.round}: ${input.envelope.value} (rejected: ${input.integrityViolation})`
    : `round ${input.envelope.round}: ${input.envelope.value}`;

  return recordAction({
    store: input.store,
    actorId: input.node.nodeId,
    actionType,
    summary,
    payload: input.envelope.payload,
    keyPair: input.node.keyPair,
  });
}

/** Independently re-verify a node's full ledger: no trust in the node that produced it required. */
export async function verifyNodeLedger(store: LedgerStore, nodeId: string): Promise<VerifyResult> {
  const entries = await store.list(nodeId);
  return verifyChain(entries);
}
