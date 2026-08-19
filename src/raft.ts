/**
 * Minimal Raft: leader election + log replication, no snapshotting, no
 * cluster membership changes, in-memory only. This is what replicates the
 * ledger and kill-switch state across control-plane replicas so neither is
 * a single point of failure.
 *
 * Deliberately a different algorithm from the Byzantine quorum in
 * `consensus.ts`, not a bigger version of it. Byzantine agreement is for
 * swarm participants you only semi-trust and needs a 2/3-style
 * supermajority; replicating your *own* control-plane state across
 * replicas you run yourself is a crash-fault-tolerant problem, and Raft's
 * plain majority (`floor(n/2) + 1`) is the correct, tighter bound for that
 * — conflating the two is a common mistake this module deliberately avoids.
 *
 * The network below is simulated in-process for deterministic testing —
 * the same way real Raft implementations (including etcd/raft) are tested
 * before being wired to a real transport. The protocol logic itself
 * (election safety, log matching, the leader-only-commits-its-own-term
 * rule from the Raft paper's Figure 8 case) is real, not simplified away.
 */

export type NodeId = string;

export interface LogEntry<TCommand> {
  readonly term: number;
  readonly index: number;
  readonly command: TCommand;
}

export type Role = 'follower' | 'candidate' | 'leader';

export interface RequestVoteArgs {
  readonly term: number;
  readonly candidateId: NodeId;
  readonly lastLogIndex: number;
  readonly lastLogTerm: number;
}

export interface RequestVoteReply {
  readonly term: number;
  readonly voteGranted: boolean;
}

export interface AppendEntriesArgs<TCommand> {
  readonly term: number;
  readonly leaderId: NodeId;
  readonly prevLogIndex: number;
  readonly prevLogTerm: number;
  readonly entries: readonly LogEntry<TCommand>[];
  readonly leaderCommit: number;
}

export interface AppendEntriesReply {
  readonly term: number;
  readonly success: boolean;
  /** Follower's log length after applying (or attempting to apply) this call — used to backtrack `nextIndex` on mismatch. */
  readonly followerLogLength: number;
}

/** What a transport delivers RPCs to — `RaftNode` satisfies this directly. */
export interface RaftRpcHandler<TCommand> {
  handleRequestVote(args: RequestVoteArgs): RequestVoteReply;
  handleAppendEntries(args: AppendEntriesArgs<TCommand>): AppendEntriesReply;
}

export interface RaftTransport<TCommand> {
  sendRequestVote(to: NodeId, args: RequestVoteArgs): Promise<RequestVoteReply | undefined>;
  sendAppendEntries(to: NodeId, args: AppendEntriesArgs<TCommand>): Promise<AppendEntriesReply | undefined>;
}

export interface RaftTimers {
  readonly electionTimeoutMinMs: number;
  readonly electionTimeoutMaxMs: number;
  readonly heartbeatIntervalMs: number;
}

// The Raft paper's own illustrative numbers (150-300ms election / 50ms
// heartbeat, a ~3-6x margin) are tighter than what production
// implementations actually run — etcd defaults to a ~10x margin (100ms
// heartbeat / 1000ms election) specifically because a margin this tight is
// prone to livelock under any jitter: a slow GC pause, a busy CPU, or (as
// this repo hit directly) synchronous ML-DSA-65 signing work competing with
// the timer callbacks on the same single JS thread. A heartbeat that
// arrives late enough to cross a too-tight election timeout looks
// indistinguishable from a dead leader, and the resulting spurious election
// can repeat indefinitely. Matching etcd's real-world ratio rather than the
// paper's minimal example is deliberate.
export const DEFAULT_TIMERS: RaftTimers = {
  electionTimeoutMinMs: 1000,
  electionTimeoutMaxMs: 2000,
  heartbeatIntervalMs: 100,
};

function majorityOf(clusterSize: number): number {
  return Math.floor(clusterSize / 2) + 1;
}

export class RaftNode<TCommand> {
  readonly id: NodeId;
  private readonly peers: readonly NodeId[];
  private readonly transport: RaftTransport<TCommand>;
  private readonly timers: RaftTimers;
  private readonly onApply: (command: TCommand, index: number) => void;

  private role: Role = 'follower';
  private currentTerm = 0;
  private votedFor: NodeId | undefined;
  private log: LogEntry<TCommand>[] = [];
  private commitIndex = 0;
  private lastApplied = 0;
  private leaderId: NodeId | undefined;

  private readonly nextIndex = new Map<NodeId, number>();
  private readonly matchIndex = new Map<NodeId, number>();

  private electionTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  private readonly commitWaiters = new Map<number, ((committed: boolean) => void)[]>();

  constructor(
    id: NodeId,
    peers: readonly NodeId[],
    transport: RaftTransport<TCommand>,
    onApply: (command: TCommand, index: number) => void,
    timers: RaftTimers = DEFAULT_TIMERS,
  ) {
    this.id = id;
    this.peers = peers;
    this.transport = transport;
    this.onApply = onApply;
    this.timers = timers;
  }

  start(): void {
    this.stopped = false;
    this.resetElectionTimer();
  }

  stop(): void {
    this.stopped = true;
    if (this.electionTimer) clearTimeout(this.electionTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  getRole(): Role {
    return this.role;
  }

  getTerm(): number {
    return this.currentTerm;
  }

  getLeaderId(): NodeId | undefined {
    return this.leaderId;
  }

  getCommitIndex(): number {
    return this.commitIndex;
  }

  /** Log entries, for tests/inspection. Index 1 is `log()[0]`. */
  getLog(): readonly LogEntry<TCommand>[] {
    return this.log;
  }

  private randomElectionTimeout(): number {
    const { electionTimeoutMinMs, electionTimeoutMaxMs } = this.timers;
    return electionTimeoutMinMs + Math.random() * (electionTimeoutMaxMs - electionTimeoutMinMs);
  }

  private resetElectionTimer(): void {
    if (this.stopped) return;
    if (this.electionTimer) clearTimeout(this.electionTimer);
    this.electionTimer = setTimeout(() => void this.startElection(), this.randomElectionTimeout());
  }

  private lastLogIndex(): number {
    return this.log.length;
  }

  private lastLogTerm(): number {
    const last = this.log[this.log.length - 1];
    return last ? last.term : 0;
  }

  private async startElection(): Promise<void> {
    if (this.stopped) return;
    this.role = 'candidate';
    this.currentTerm += 1;
    this.votedFor = this.id;
    this.leaderId = undefined;
    const electionTerm = this.currentTerm;
    let votes = 1;
    this.resetElectionTimer();

    const results = await Promise.all(
      this.peers.map((peer) =>
        this.transport.sendRequestVote(peer, {
          term: electionTerm,
          candidateId: this.id,
          lastLogIndex: this.lastLogIndex(),
          lastLogTerm: this.lastLogTerm(),
        }),
      ),
    );

    if (this.stopped || this.role !== 'candidate' || this.currentTerm !== electionTerm) return;

    for (const reply of results) {
      if (!reply) continue;
      if (reply.term > this.currentTerm) {
        this.becomeFollower(reply.term);
        return;
      }
      if (reply.voteGranted) votes += 1;
    }

    if (votes >= majorityOf(this.peers.length + 1)) {
      this.becomeLeader();
    }
  }

  private becomeFollower(term: number): void {
    this.role = 'follower';
    this.currentTerm = term;
    this.votedFor = undefined;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.resetElectionTimer();
    // Stepping down means this node can no longer guarantee any of its own
    // pending, not-yet-committed proposals will ever commit — without this,
    // propose() on an entry that gets orphaned this way would hang forever.
    // Reject rather than silently drop: callers can retry against whichever
    // node is leader next.
    this.rejectCommitWaitersFrom(0);
  }

  private becomeLeader(): void {
    this.role = 'leader';
    this.leaderId = this.id;
    if (this.electionTimer) clearTimeout(this.electionTimer);
    for (const peer of this.peers) {
      this.nextIndex.set(peer, this.lastLogIndex() + 1);
      this.matchIndex.set(peer, 0);
    }
    void this.sendHeartbeats();
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeats(), this.timers.heartbeatIntervalMs);
  }

  private async sendHeartbeats(): Promise<void> {
    if (this.stopped || this.role !== 'leader') return;
    const term = this.currentTerm;
    await Promise.all(this.peers.map((peer) => this.replicateTo(peer, term)));
    if (!this.stopped && this.role === 'leader' && this.currentTerm === term) {
      this.updateCommitIndex();
    }
  }

  private async replicateTo(peer: NodeId, term: number): Promise<void> {
    const next = this.nextIndex.get(peer) ?? this.lastLogIndex() + 1;
    const prevLogIndex = next - 1;
    const prevLogTerm = prevLogIndex > 0 ? (this.log[prevLogIndex - 1]?.term ?? 0) : 0;
    const entries = this.log.slice(prevLogIndex);

    const reply = await this.transport.sendAppendEntries(peer, {
      term,
      leaderId: this.id,
      prevLogIndex,
      prevLogTerm,
      entries,
      leaderCommit: this.commitIndex,
    });
    if (!reply || this.stopped || this.role !== 'leader' || this.currentTerm !== term) return;

    if (reply.term > this.currentTerm) {
      this.becomeFollower(reply.term);
      return;
    }
    if (reply.success) {
      this.matchIndex.set(peer, prevLogIndex + entries.length);
      this.nextIndex.set(peer, prevLogIndex + entries.length + 1);
    } else {
      // Back off by one and retry next round — a minimal but correct
      // backtrack; a production implementation would use the follower's
      // conflict term to skip back faster.
      this.nextIndex.set(peer, Math.max(1, Math.min(next - 1, reply.followerLogLength + 1)));
    }
  }

  /** Raft's Figure 8 rule: only commit by counting replicas of an entry from the *current* term. */
  private updateCommitIndex(): void {
    for (let n = this.lastLogIndex(); n > this.commitIndex; n--) {
      const entry = this.log[n - 1];
      if (!entry || entry.term !== this.currentTerm) continue;
      let replicas = 1; // self
      for (const peer of this.peers) {
        if ((this.matchIndex.get(peer) ?? 0) >= n) replicas += 1;
      }
      if (replicas >= majorityOf(this.peers.length + 1)) {
        this.advanceCommitIndex(n);
        return;
      }
    }
  }

  private advanceCommitIndex(newCommitIndex: number): void {
    if (newCommitIndex <= this.commitIndex) return;
    this.commitIndex = newCommitIndex;
    this.applyCommitted();
    this.resolveCommitWaiters();
  }

  private applyCommitted(): void {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied += 1;
      const entry = this.log[this.lastApplied - 1];
      if (entry) this.onApply(entry.command, entry.index);
    }
  }

  private resolveCommitWaiters(): void {
    for (const [index, resolvers] of [...this.commitWaiters.entries()]) {
      if (index <= this.commitIndex) {
        for (const resolve of resolvers) resolve(true);
        this.commitWaiters.delete(index);
      }
    }
  }

  /** Rejects (not silently drops) waiters for `index >= fromIndex` — used when their log entries are truncated or this node steps down. */
  private rejectCommitWaitersFrom(fromIndex: number): void {
    for (const [index, resolvers] of [...this.commitWaiters.entries()]) {
      if (index >= fromIndex) {
        for (const resolve of resolvers) resolve(false);
        this.commitWaiters.delete(index);
      }
    }
  }

  /** Leader-only: append `command`, replicate it, and resolve once a majority has committed it. Rejects if not currently leader. */
  async propose(command: TCommand): Promise<number> {
    if (this.role !== 'leader') {
      throw new Error(`propose() called on non-leader node ${this.id} (role=${this.role})`);
    }
    const index = this.lastLogIndex() + 1;
    this.log.push({ term: this.currentTerm, index, command });

    const committed = await new Promise<boolean>((resolve) => {
      const waiters = this.commitWaiters.get(index) ?? [];
      waiters.push(resolve);
      this.commitWaiters.set(index, waiters);
    });
    if (!committed) throw new Error(`entry at index ${index} was never committed`);
    return index;
  }

  // --- RPC handlers, called by the transport on behalf of a peer ---

  handleRequestVote(args: RequestVoteArgs): RequestVoteReply {
    if (args.term > this.currentTerm) this.becomeFollower(args.term);
    if (args.term < this.currentTerm) {
      return { term: this.currentTerm, voteGranted: false };
    }

    const alreadyVotedForOther = this.votedFor !== undefined && this.votedFor !== args.candidateId;
    const candidateLogIsUpToDate =
      args.lastLogTerm > this.lastLogTerm() ||
      (args.lastLogTerm === this.lastLogTerm() && args.lastLogIndex >= this.lastLogIndex());

    if (!alreadyVotedForOther && candidateLogIsUpToDate) {
      this.votedFor = args.candidateId;
      this.resetElectionTimer();
      return { term: this.currentTerm, voteGranted: true };
    }
    return { term: this.currentTerm, voteGranted: false };
  }

  handleAppendEntries(args: AppendEntriesArgs<TCommand>): AppendEntriesReply {
    if (args.term > this.currentTerm) this.becomeFollower(args.term);
    if (args.term < this.currentTerm) {
      return { term: this.currentTerm, success: false, followerLogLength: this.log.length };
    }

    this.role = 'follower';
    this.leaderId = args.leaderId;
    this.resetElectionTimer();

    if (args.prevLogIndex > 0) {
      const prevEntry = this.log[args.prevLogIndex - 1];
      if (!prevEntry || prevEntry.term !== args.prevLogTerm) {
        return { term: this.currentTerm, success: false, followerLogLength: this.log.length };
      }
    }

    let writeIndex = args.prevLogIndex;
    for (const entry of args.entries) {
      writeIndex += 1;
      const existing = this.log[writeIndex - 1];
      if (existing && existing.term !== entry.term) {
        this.log = this.log.slice(0, writeIndex - 1);
        // Whatever was at and after this index is gone — any propose() still
        // waiting on those indices would otherwise hang forever.
        this.rejectCommitWaitersFrom(writeIndex);
      }
      if (!this.log[writeIndex - 1]) {
        this.log.push(entry);
      }
    }

    if (args.leaderCommit > this.commitIndex) {
      this.advanceCommitIndex(Math.min(args.leaderCommit, this.log.length));
    }

    return { term: this.currentTerm, success: true, followerLogLength: this.log.length };
  }
}
