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

The repository currently contains the frozen contract for the first tracer
bullet. No implementation or runtime behavior is claimed yet.

See
[`design-specs/0001-truth-bound-capability-roadmap.md`](design-specs/0001-truth-bound-capability-roadmap.md).

## Independence

Workgraph originated from project-management patterns exercised by Semantic
Systems, but it is maintained as an independent product. Its portable core
must not depend on Semantic Systems vocabulary, GitHub, Herdr, a particular
storage engine, or a particular JavaScript runtime.

## License

No open-source license has been selected yet. Public visibility does not grant
permission to copy, modify, or redistribute the repository.
