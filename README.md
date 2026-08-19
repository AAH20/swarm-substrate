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

## Try it

```bash
npm install
npm run demo    # runs the adversarial scenario, prints a pass/fail report
npm test         # the same checks, as real assertions
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

- Consensus is a single round, single decision, no network — not a
  production BFT protocol.
- Integrity checks three specific, real attack classes; it is not a general
  content firewall.
- The kill switch and consensus run in the same process in this reference
  stack; production use would run runtime control genuinely out-of-process.
- The ledger store here is in-memory (`InMemoryLedgerStore`); `pqattest`
  itself ships a durable `FileLedgerStore` for persistent use.

## License

Apache-2.0
