/**
 * In-process simulated network for Raft. Deterministic-enough for tests
 * (fixed, small latency; no reordering) while still exercising real async
 * concurrency — the protocol logic in `raft.ts` doesn't know the transport
 * is simulated, and a real socket-based `RaftTransport` implementation
 * would plug into `RaftNode` unchanged.
 *
 * `kill()` is what lets tests prove no-single-point-of-failure for real:
 * dropping every message to/from a node simulates it crashing, without
 * tearing down the process it runs in.
 */
import type { RaftTransport, RaftRpcHandler, NodeId } from './raft.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SimulatedRaftNetwork<TCommand> {
  private readonly nodes = new Map<NodeId, RaftRpcHandler<TCommand>>();
  private readonly killed = new Set<NodeId>();

  constructor(private readonly latencyMs = 5) {}

  register(nodeId: NodeId, node: RaftRpcHandler<TCommand>): void {
    this.nodes.set(nodeId, node);
  }

  kill(nodeId: NodeId): void {
    this.killed.add(nodeId);
  }

  revive(nodeId: NodeId): void {
    this.killed.delete(nodeId);
  }

  isAlive(nodeId: NodeId): boolean {
    return !this.killed.has(nodeId);
  }

  transportFor(nodeId: NodeId): RaftTransport<TCommand> {
    return {
      sendRequestVote: async (to, args) => {
        if (this.killed.has(nodeId) || this.killed.has(to)) return undefined;
        await delay(this.latencyMs);
        if (this.killed.has(nodeId) || this.killed.has(to)) return undefined;
        return this.nodes.get(to)?.handleRequestVote(args);
      },
      sendAppendEntries: async (to, args) => {
        if (this.killed.has(nodeId) || this.killed.has(to)) return undefined;
        await delay(this.latencyMs);
        if (this.killed.has(nodeId) || this.killed.has(to)) return undefined;
        return this.nodes.get(to)?.handleAppendEntries(args);
      },
    };
  }
}
