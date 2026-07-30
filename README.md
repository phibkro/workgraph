# Workgraph

Workgraph is a local-first, evidence-bound graph for managing human and agent
work.

Instead of treating a board, issue status, or agent summary as truth, Workgraph
keeps one typed canonical graph and an append-only transition history. It then
derives roadmap, skill-tree, dependency, milestone, status, blocker, research,
and agent-session views from that source.

The central rule is simple:

> Every state transition must reference why it happened.

A transition may be justified by an exact commit, artifact digest, reproducible
check result, review, external observation, or explicitly identified human
approval. These are different authority and evidence categories. A human
approval remains a visible human assertion; it is never relabeled as a
machine-checkable result.

## Intended views

- capability and skill-tree roadmap;
- dependency schedule and available-work frontier;
- milestone acceptance state;
- research, decision, and counterevidence map;
- blockers with derivation explanations;
- exact artifact, review, and check provenance;
- agent ownership, session, handoff, and cleanup overlays;
- deterministic Markdown, Mermaid, JSON, and interactive projections.

The canonical structure is a graph, not a DAG. Feedback, observation, revision,
and supersession may form cycles. A dependency-scheduling view is a derived
acyclic projection over only the edge kinds whose contracts require acyclicity.

## Status

The frozen contract for the first tracer bullet is
[`design-specs/0001-truth-bound-capability-roadmap.md`](design-specs/0001-truth-bound-capability-roadmap.md).

The first tracer implementation is present:

- a portable canonical core (`src/core`): typed graph, exact references,
  transition validation, deterministic normalization, and an explainable
  derivation engine;
- the committed fictional fixture (`src/fixture`) exercising every fixture
  requirement in the spec;
- one journey composed twice (`src/cli`): Effect layers for Bun and for Node,
  producing byte-equivalent generated views;
- deterministic generated projections (`generated/`), each bound to the
  canonical graph digest and guarded by a drift check; and
- the executable gates established by the spec:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run accept:0001   # requires a genuine Node.js on PATH, not Bun's node shim
```

These gates are machine checks bound to the run that executes them. They do
not establish independent review, operational suitability, or human approval.

## Independence

Workgraph originated from project-management patterns exercised by Semantic
Systems, but it is maintained as an independent product. Its portable core
must not depend on Semantic Systems vocabulary, GitHub, Herdr, a particular
storage engine, or a particular JavaScript runtime.

## License

No open-source license has been selected yet. Public visibility does not grant
permission to copy, modify, or redistribute the repository.
