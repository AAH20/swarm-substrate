# swarm-substrate

A reference implementation of the trust substrate underneath multi-agent
swarm orchestration — proof that it composes, not a diagram of how it might.

Orchestration frameworks (LangGraph, CrewAI, AutoGen, and similar) solve
message-passing and workflow routing between agents. They all assume the
swarm already behaves: that agents are telling the truth about what they
did, that a bad actor can be stopped, that inputs are clean, that agreement
among agents means what it claims to mean. This repo is the layer those
assumptions actually depend on, wired together end to end:

```
integrity  →  provenance  →  consensus  →  runtime control  →  assurance
(clean          (attributable    (agreement       (out-of-band       (independent
 inputs)         actions)         despite           breaker)          verification)
                                  faults)
```

Each arrow is a real dependency, not a suggestion. Byzantine consensus
requires attributable, unforgeable votes — you cannot do Byzantine agreement
without cryptographic attribution of who voted for what, which is why
provenance sits *before* consensus, not next to it as a separate feature.
Runtime control has to sit outside the consensus computation, or a bug or
compromise in that computation could take the breaker down with it.
Assurance exists because a system grading its own emergent behavior is the
same self-graded-homework problem as a vendor self-attesting its own
actions — nobody outside the builder should have to just take its word for
it.

## What's actually here

- **`integrity`** — a narrow input gate: catches prototype-pollution keys
  (`__proto__`, `constructor`, `prototype`) delivered the way they'd
  actually arrive over the wire (via `JSON.parse`, which doesn't
  special-case them the way an object literal does — this distinction
  matters and is tested), non-JSON-serializable payloads, and oversized
  fields. It does not judge semantic correctness; that's what the rest of
  the stack is for.
- **`provenance`** — every envelope, accepted or rejected, gets signed and
  hash-chained via [`pqattest`](https://github.com/AAH20/pqattest)
  (ML-DSA-65 / FIPS 204, ratified NIST post-quantum signatures — a real
  npm-installable dependency of this repo, not a reimplementation).
  Rejected envelopes are attested too, deliberately: a caught attack should
  leave evidence it was attempted, not vanish silently.
- **`consensus`** — a minimal single-round Byzantine quorum: `floor(2n/3) +
  1` votes decide, tolerating fewer than `n/3` faulty nodes (the standard
  `n ≥ 3f + 1` bound). This is **not** PBFT, Tendermint, or HotStuff — no
  view changes, no leader election, no partition handling. It's the
  smallest real quorum rule that demonstrates the property that matters:
  honest majority decides regardless of a faulty minority's votes.
- **`killswitch`** — tracks integrity violations per node and quarantines a
  node once a threshold is crossed, independent of the consensus
  computation. In this reference stack it's in-process, not a literal
  separate machine — the composition proves the *logical* separation
  (nothing about tripping it depends on consensus internals), which is the
  property that matters; a production deployment would run it out of
  process.
- **`redteam`** — the adversarial scenario: assembles a 4-node swarm with
  one byzantine member and asserts, against the real output of the rest of
  the stack (not against what the modules are supposed to do), that every
  claimed guarantee actually held.

## Scaling it: hierarchical consensus and a replicated control plane

Flat BFT quorum voting is O(n²) message complexity — fine at n=4, dead on
arrival at real swarm scale. Two additions address that and the other
structural gap in v0.1: the kill-switch and ledger were themselves single
points of failure.

- **`committee-consensus`** — partitions the swarm into committees, runs the
  existing quorum rule inside each one, then treats each committee's
  decision as one vote in a meta-round. This scales the *cost* of Byzantine
  agreement down to committee size, and it scales the *fault tolerance* up a
  level: it tolerates an entire committee being compromised, not just a
  minority of individual nodes within one, as long as fewer than a third of
  committees are compromised.
- **`raft` + `replicated-control-plane`** — a real, minimal Raft
  implementation (leader election, log replication, the leader-only-commits-
  its-own-term rule from the Raft paper's Figure 8 case) replicates the
  ledger and kill-switch state across control-plane replicas. This is
  deliberately a *different* algorithm from the Byzantine quorum above, not
  a bigger version of it: replicating your own control-plane state across
  replicas you run yourself is a crash-fault-tolerant problem (plain
  majority, `floor(n/2) + 1`), not a Byzantine one (swarm participants you
  only semi-trust, `floor(2n/3) + 1`) — conflating those two is a common
  mistake this repo deliberately avoids. Kill the current leader and a new
  one takes over with no data loss; that's the actual "no single point of
  failure" claim, proven by killing a node mid-test, not asserted.

The network underneath Raft is simulated in-process — deterministic enough
to test, the same way real Raft implementations (including etcd/raft) are
tested before being wired to a real transport. The protocol logic doesn't
know the difference; a socket-based transport would plug in unchanged.

## Try it

```bash
npm install
npm run demo      # the v0.1 adversarial scenario: integrity → provenance → consensus → kill-switch
npm run demo:v2   # hierarchical consensus + a leader crash the control plane survives
npm test           # the same checks, as real assertions (28 tests)
```

The scenario (`n = 4`, quorum `= 3`, kill-switch threshold `= 2`):

1. Round 1 — the byzantine node submits a poisoned proposal (a
   `JSON.parse`-derived `__proto__` payload). Integrity catches it; the
   attempt is attested anyway.
2. Round 2 — the byzantine node casts a dissenting vote. Consensus still
   decides the honest value — that's the whole point of a Byzantine quorum.
3. Round 3 — a second poisoned payload crosses the kill-switch threshold;
   the node is quarantined.
4. Round 4 — the quarantined node is excluded before integrity even runs;
   the remaining three honest nodes still reach quorum on their own.

Then every node's ledger is independently re-verified — no trust in
whichever node produced it required, the same as `pqattest`'s own
`verifyChain`.

## What this composes with

This repo is deliberately thin — it doesn't vendor or duplicate the modules
it's proving out. `pqattest` is a real dependency today. The other layers
here (`consensus`, `killswitch`, an `integrity` scanner) are minimal
reference versions of what
[`bft-agent-consensus`](https://github.com/AAH20/bft-agent-consensus),
[`agent-kill-switch`](https://github.com/AAH20/agent-kill-switch), and
[`mcp-shield`](https://github.com/AAH20/mcp-shield) are meant to become as
those modules mature — each of those is a separate, independently-versioned
primitive, not required to be complete on its own for this composition to
be real today.

## Honest scope

- Consensus (both the flat quorum and the hierarchical committee version) is
  single-round, no network, no view changes — not a production BFT protocol
  like PBFT, Tendermint, or HotStuff.
- Integrity checks three specific, real attack classes; it is not a general
  content firewall.
- Raft here has no snapshotting/log compaction and no cluster membership
  changes; it's leader election and log replication, the two properties this
  repo's claims depend on, not a complete production Raft.
- The Raft network transport is simulated in-process, not real sockets — the
  protocol logic is real and a real transport would plug in unchanged, but
  this repo doesn't ship one.
- Reads (`list`, `isQuarantined`) on `ReplicatedControlPlane` are served from
  whichever replica you call them on; a follower's locally-applied state can
  lag the leader's by one replication round. Call them on the current leader
  (`cluster.currentLeader()`) for the latest committed view — this repo
  doesn't implement Raft's read-index optimization for safe follower reads.
- The unreplicated `InMemoryLedgerStore`/`KillSwitch` from v0.1 are still
  here and still useful for the simpler single-process case; `pqattest`
  itself ships a durable `FileLedgerStore` for persistent, non-replicated use.

## License

Apache-2.0
