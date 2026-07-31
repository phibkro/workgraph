# Plan 0002: local command loop

Status: implementation in progress; mutation, publication, and recovery remain incomplete

Frozen base: `ba9fecdd56a3a0b592604e79b55715363e6ee5f3`

Contract: `design-specs/0002-local-command-loop.md`

## Integrated implementation checkpoints

The main branch contains these accepted partial slices:

- explicit policy registry and bounded document codec;
- pure digest-bound append decisions and receipt validation;
- retained-root Bun and Node read custody;
- read-only local document inspection;
- deterministic JSON output for the `inspect` CLI command;
- deterministic in-memory projection snapshots with source identity, file
  digests, manifest, tree digest, snapshot name, and pointer bytes.

The latest projection snapshot checkpoint is `95187ef`. Bun and genuine Node
produce the pinned tree and pointer identities. The receipt also binds the
complete resolved policy registry. The canonical repository gate passes with
68 tests.

These checkpoints do not complete design 0002. The exact acceptance command
remains red. The remaining product work includes:

- genesis and append mutation adapters;
- public fence inspection and authorized recovery;
- immutable projection publication, inspection, and recovery;
- the remaining CLI commands;
- the usage guide and local agent skill;
- the complete fault, interruption, and cross-process acceptance matrix.

Do not move this plan to `plans/completed/` until every frozen acceptance item
has direct executable evidence.

## First independent contract review

Reviewed head: `24a8e3a243a414f46dc5279c3723ea6bd7bd19b7`

Verdict: `CHANGES_REQUIRED`

The review found four blocking gaps:

1. The policy registry digest did not define a complete normalized registry.
2. The path model did not retain an enforceable directory capability.
3. Pre-rename store failures did not have a total public outcome.
4. Receipts did not form a reconstructable chain from deterministic genesis.

This recut resolves each gap in the frozen contract. The review verdict remains
an observation about the rejected head. It is not an acceptance of this recut.

## Second independent contract review

Reviewed head: `800d0f1e998e6c61dfb5f123aaf1aa244b4707d7`

Verdict: `CHANGES_REQUIRED`

The second review found four blocking gaps:

1. Receipt-prefix verification was quadratic under the public input bounds.
2. Genesis crash residue had no executable recovery protocol.
3. Numeric-exhaustion decisions were unreachable through public decoding.
4. Projection writes had no total partial-output failure observations.

This recut replaces prefix reconstruction with an O(n) event chain. It adds
genesis recovery and total projection publication outcomes.

It also removes unreachable numeric-exhaustion decisions. Public collection
bounds now own that rejection.

The verdict remains an observation about `800d0f1`. It is not acceptance of
this recut.

## Third independent contract review

Reviewed head: `f1646a3be8509dfc39736a89e860b039a2b2d34f`

Verdict: `CHANGES_REQUIRED`

The third review found four blocking gaps:

1. Genesis recovery removed the public lock before it fenced the old writer.
2. The authority-bearing document digest was not defined.
3. A crashed projection owner had no projection-lock recovery journey.
4. The acceptance scaffold omitted the projection-store implementation file.

This recut keeps one canonical public fence through recovery. It requires
exact predecessor-death evidence before an atomic same-name token handoff.

It defines the complete document digest and its Bun and Node probes. It also
adds operator-authorized projection-lock recovery and the missing scaffold
entry.

The verdict remains an observation about `f1646a3`. It is not acceptance of
this recut.

## Product dependency

```text
0001 portable graph and projection semantics
                  |
                  v
0002 explicit policy registry and document codec
                  |
                  v
0002 digest-bound append decision
                  |
                  v
0002 Bun and Node atomic store adapters
          +-------+-------+
          |               |
          v               v
  local CLI and API   read-only projections
          |
          v
   local agent skill
          |
          v
future Control Room adapter
```

The Control Room adapter requires both products. It is not part of 0002.

## Frozen slices

### Slice 1: portable decisions

- Add an explicit immutable policy registry.
- Normalize and digest generic built-ins plus optional data definitions.
- Move Orchard rules from the module-global map to an explicit fixture value.
- Add local document, identity, receipt, and command types.
- Add deterministic genesis and coherent receipt-chain validation.
- Use one append-verifiable event chain with a counted O(n) work bound.
- Add the pure append decision.
- Add prefix, correction, registry conflict, and idempotency tests.

### Slice 2: decode and identify

- Add the bounded duplicate-key-safe decoder.
- Add deterministic document encoding.
- Add the exact domain-separated complete-document digest.
- Add the SHA-256 service boundary.
- Add malformed, hostile, parity, and digest-mutation tests.

### Slice 3: local custody

- Add the Effect store service.
- Add Bun and Node live layers.
- Add Linux retained-directory-handle custody.
- Add one audited Linux `flock(2)` bridge for Bun and Node fence custody.
- Add lock, temporary-file, sync, rename, and read-back handling.
- Add total pre-rename and unknown post-rename outcomes.
- Add a no-gap canonical fence handoff with exact owner-death evidence.
- Add exact genesis finalize and abort recovery under that fence.
- Add ancestor-swap, link, command-file, and cleanup adversaries.

### Slice 4: product surfaces

- Add the shared CLI parser and JSON outcomes.
- Keep the 0001 commands compatible.
- Add digest-bound local projections and drift checks.
- Publish projections through immutable snapshots and an atomic active pointer.
- Add total projection failure and unknown outcomes.
- Add read-only projection-lock inspection and authorized dead-owner recovery.
- Add the usage guide.
- Add the local agent skill.

### Slice 5: acceptance

- Run the canonical full gate.
- Run both accepted tracer gates.
- Validate the skill.
- Run the fresh-agent unknown-outcome journey.
- Record exact source and environment observations.

## Frozen implementation ownership

The implementation owns only the modules and deliverables named in the design
spec. It must not import Semantic Systems or add a Control Room adapter.

The implementation can change 0001 composition call sites to pass the fixture
registry. It must not revise 0001 fixture semantics.

If a registry refactor changes generated 0001 bytes, stop and report the
incompatibility.

## Review checkpoints

1. Review registry normalization and O(n) receipt coherence before store work.
2. Review the pure append decision before filesystem work.
3. Review process identity and canonical fence handoff before a live adapter
   runs.
4. Review Linux handle-relative custody before a live adapter runs.
5. Review genesis and projection-lock recovery at every interruption boundary.
6. Review every store and projection fault outcome before CLI integration.
7. Run an independent exact-head review before integration.

## Deferred decisions

- A later tracer can define signed policy registries.
- A later tracer can define automatic lock leases.
- A later tracer can define Windows replacement semantics.
- A later tracer can define a Control Room projection adapter.

No deferred decision blocks the 0002 implementation.

The narrow native `flock(2)` bridge is a documented stack divergence.
Pathname-only TypeScript APIs cannot remove the recovery
check-to-mutation race. The bridge starts no process and exposes only typed
exclusive-fence custody.
