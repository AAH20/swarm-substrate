/**
 * Replicates the ledger and the kill-switch state across a Raft cluster, so
 * neither is a single point of failure: killing whichever replica currently
 * holds leadership doesn't lose committed state, and a new leader picks up
 * writes once elected.
 *
 * Every command — a ledger append, a kill-switch violation — goes through
 * `RaftNode.propose()`, which only resolves once a majority of replicas
 * have durably committed it. Writes must go through whichever node is
 * currently leader; a real deployment would forward a follower's write to
 * the leader transparently, this reference implementation keeps that
 * routing explicit (`findLeader`) rather than hiding it. Reads here are
 * served from whichever replica you call them on, applied from its own
 * locally-committed log — a follower's locally-applied state can lag the
 * leader's by at most one replication round; call `list`/`isQuarantined`
 * on the current leader if you need the latest committed view.
 */
import type { LedgerStore, AttestationEntry } from 'pqattest';
import { RaftNode, type NodeId, type RaftTimers, DEFAULT_TIMERS } from './raft.js';
import { SimulatedRaftNetwork } from './raft-network.js';
import type { ViolationResult } from './killswitch.js';

export type ReplicatedCommand =
  | { readonly kind: 'ledger-append'; readonly entry: AttestationEntry }
  | { readonly kind: 'killswitch-violation'; readonly nodeId: string };

export class ReplicatedControlPlane implements LedgerStore {
  private readonly ledgerByActor = new Map<string, AttestationEntry[]>();
  private readonly violations = new Map<string, number>();
  private readonly quarantined = new Set<string>();

  constructor(
    readonly raft: RaftNode<ReplicatedCommand>,
    private readonly killSwitchThreshold: number,
  ) {}

  /** Called by the owning `RaftNode` once a command commits — applies it to this replica's local state. */
  apply(command: ReplicatedCommand): void {
    if (command.kind === 'ledger-append') {
      const list = this.ledgerByActor.get(command.entry.actorId) ?? [];
      list.push(command.entry);
      this.ledgerByActor.set(command.entry.actorId, list);
      return;
    }
    const count = (this.violations.get(command.nodeId) ?? 0) + 1;
    this.violations.set(command.nodeId, count);
    if (count >= this.killSwitchThreshold) this.quarantined.add(command.nodeId);
  }

  // --- LedgerStore ---

  async getLast(actorId: string): Promise<AttestationEntry | undefined> {
    const list = this.ledgerByActor.get(actorId);
    return list?.[list.length - 1];
  }

  async append(entry: AttestationEntry): Promise<void> {
    await this.raft.propose({ kind: 'ledger-append', entry });
  }

  async list(actorId: string): Promise<AttestationEntry[]> {
    return [...(this.ledgerByActor.get(actorId) ?? [])];
  }

  // --- kill-switch, replicated ---

  isQuarantined(nodeId: string): boolean {
    return this.quarantined.has(nodeId);
  }

  quarantinedNodes(): readonly string[] {
    return [...this.quarantined];
  }

  async recordViolation(nodeId: string): Promise<ViolationResult> {
    const wasQuarantined = this.quarantined.has(nodeId);
    await this.raft.propose({ kind: 'killswitch-violation', nodeId });
    const count = this.violations.get(nodeId) ?? 0;
    const tripped = !wasQuarantined && this.quarantined.has(nodeId);
    return { nodeId, count, tripped };
  }
}

export interface ControlPlaneReplicaSet {
  readonly replicas: ReadonlyMap<NodeId, ReplicatedControlPlane>;
  readonly rafts: ReadonlyMap<NodeId, RaftNode<ReplicatedCommand>>;
  readonly network: SimulatedRaftNetwork<ReplicatedCommand>;
  start(): void;
  stop(): void;
  /** Simulates a crash: the node stops executing *and* becomes unreachable — not just unreachable while secretly still ticking. */
  kill(nodeId: NodeId): void;
  revive(nodeId: NodeId): void;
  /** Only considers replicas that are both self-reporting leader *and* currently reachable — querying a node's own stale in-memory state without going through the network isn't something a real caller could do either. */
  currentLeader(): ReplicatedControlPlane | undefined;
}

/** Wires up `nodeIds.length` replicas, each with its own `RaftNode` and its own `ReplicatedControlPlane`, sharing one simulated network. */
export function createControlPlaneCluster(
  nodeIds: readonly NodeId[],
  killSwitchThreshold: number,
  timers: RaftTimers = DEFAULT_TIMERS,
): ControlPlaneReplicaSet {
  const network = new SimulatedRaftNetwork<ReplicatedCommand>();
  const replicas = new Map<NodeId, ReplicatedControlPlane>();
  const rafts = new Map<NodeId, RaftNode<ReplicatedCommand>>();

  for (const id of nodeIds) {
    const peers = nodeIds.filter((n) => n !== id);
    const raft: RaftNode<ReplicatedCommand> = new RaftNode(
      id,
      peers,
      network.transportFor(id),
      (command) => replicas.get(id)?.apply(command),
      timers,
    );
    rafts.set(id, raft);
    replicas.set(id, new ReplicatedControlPlane(raft, killSwitchThreshold));
    network.register(id, raft);
  }

  return {
    replicas,
    rafts,
    network,
    start: () => {
      for (const raft of rafts.values()) raft.start();
    },
    stop: () => {
      for (const raft of rafts.values()) raft.stop();
    },
    kill: (nodeId) => {
      network.kill(nodeId);
      rafts.get(nodeId)?.stop();
    },
    revive: (nodeId) => {
      network.revive(nodeId);
      rafts.get(nodeId)?.start();
    },
    currentLeader: () => {
      for (const [id, raft] of rafts) {
        if (raft.getRole() === 'leader' && network.isAlive(id)) return replicas.get(id);
      }
      return undefined;
    },
  };
}
