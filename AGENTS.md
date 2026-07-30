# Workgraph agent contract

## Thesis

Workgraph is a local-first, evidence-bound work graph for humans and agents.
Canonical truth is a typed graph plus an append-only transition history.
Roadmaps, skill trees, dependency schedules, boards, reports, and agent views
are deterministic projections of that truth.

## Non-negotiable invariants

- A derived view is never an authority and is never edited by hand.
- Every state transition names its exact subject and at least one exact basis
  reference.
- A commit is an artifact and an observation, not proof that its claims are
  true.
- Machine checks, human approvals, imported observations, tests, reviews, and
  assumptions remain distinct.
- A human-approved transition is explicitly typed as a human assertion. It
  must never be represented as machine verification.
- Every derived status and recommendation is explainable through named rules
  and source references.
- The canonical model is a typed directed property multigraph. Individual
  projections may impose stronger constraints, such as acyclic dependency or
  containment edges.
- Corrections supersede prior events; they do not erase history.
- Keep the portable domain core independent of GitHub, Herdr, Semantic
  Systems, storage engines, and JavaScript runtimes.

## Product boundary

Workgraph is independently maintained. Semantic Systems may consume it and
provide extension vocabulary, but Workgraph must never import Semantic Systems
domain semantics.

External systems such as Git, GitHub, CI, Herdr, and issue trackers are
adapters. Their records enter as typed observations or references. They do not
silently become canonical work state.

## Implementation posture

- Specify and freeze one observable tracer before implementation.
- Prefer TypeScript, Bun, and Effect v4.
- Keep the core and seams pure and explicit. Use Effect for replaceable
  capabilities and interpretations.
- Keep Bun as the default runtime and package manager; support Node through a
  swappable runtime composition boundary.
- Model portable, stateful, integration, and runtime-specific packages as
  separate domains.
- Search installed tooling and license-compatible prior art before writing
  infrastructure.
- Do not use Pagu.

## Validation

The first implementation must establish its commands in the frozen design
spec before claiming any validation. Until then, report the repository as a
contract-only scaffold.

## Generated artifacts

Generated projections must carry the canonical graph revision or digest from
which they were derived. A drift check must regenerate and compare them.

## Public claims

Do not claim formal proof, authentication, successful execution, operational
suitability, or human approval from an adjacent evidence category. Unsupported
claims remain visible.
