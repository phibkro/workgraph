# Design spec 0001: truth-bound capability roadmap

Status: frozen for the first tracer bullet

Date: 2026-07-30

## Problem

Human and agent work is currently spread across plans, commits, issue states,
terminal sessions, reviews, test output, and manager memory. Each system can
display a plausible status while referring to a different artifact or moment
in time. A board checkbox or an agent's assertion can therefore say "done"
without proving what changed, what was checked, or whether the checked content
is the content being accepted.

Dependency DAGs help schedule work but do not represent the complete project
system. Research revises designs, operational observations reopen assumptions,
counterevidence returns work to an earlier frontier, and accepted capabilities
unlock multiple future paths. The canonical structure must therefore support
typed cycles while still deriving acyclic scheduling and skill-tree views where
appropriate.

## Goal

Provide one local-first canonical work graph whose state transitions are bound
to exact references and whose disposable views explain:

- what capabilities have been established;
- what is available, active, waiting, blocked, stale, or achieved;
- why each derived state holds;
- what evidence or human authority caused each transition;
- which future capabilities each accepted result unlocks; and
- how research, implementation, evaluation, and revision close the feedback
  loop.

## User journey

1. An operator creates a small project graph containing a research question, a
   frozen design, an implementation experiment, an acceptance gate, and a
   capability that the accepted experiment may unlock.
2. An agent asks for available work and receives the experiment plus an
   explanation of every satisfied prerequisite.
3. The agent records a commit and a machine check against that exact commit.
   A transition request references both.
4. The engine accepts the transition only when the named policy can derive it
   from the referenced facts. The capability becomes unlocked.
5. A second transition is approved by a human. Its record visibly says
   `human_approval` and `human_approved_assertion`; no view calls it a machine
   check, proof, or independently verified fact.
6. A failing operational observation supplies counterevidence. The graph keeps
   the earlier accepted history, records the new observation, and derives a
   revision frontier rather than silently rewriting history.
7. The operator generates a capability roadmap, a dependency schedule, a
   milestone report, and a transition explanation. Every projection carries
   the exact canonical revision or digest from which it was generated.

## Values

- Correctness by construction over retrospective reconciliation.
- One canonical source with explicit derivation edges.
- Exact subject identity over branch names, mutable issue states, or prose.
- Typed authority and evidence over generic "verified" booleans.
- Explainable derivation over opaque automation.
- Capabilities and validated knowledge over ticket throughput.
- Local ownership with replaceable external integrations.

## Canonical model

The canonical model is a typed directed property multigraph plus an append-only
event history.

### Node families

The first tracer supports:

- project;
- milestone;
- capability;
- research question or hypothesis;
- design contract;
- work item or experiment;
- decision;
- risk or uncertainty;
- acceptance gate;
- artifact;
- evidence or observation;
- human approval; and
- agent session.

This is a minimal generic vocabulary. Consumers may add namespaced extension
types without changing the meaning of the core types.

### Relation families

The first tracer supports:

- `contains`;
- `requires`;
- `blocks`;
- `enables`;
- `implements`;
- `evaluates`;
- `supports`;
- `contradicts`;
- `derived_from`;
- `supersedes`;
- `owned_by`;
- `assigned_to`; and
- `observed_by`.

Multiple typed edges may connect the same nodes. Edge identity and attributes
must be preserved.

### Cycle policy

The canonical graph may contain cycles.

- `requires` and `contains` must be acyclic within the scope evaluated by their
  respective scheduling and hierarchy policies. A cycle is invalid input, not
  a roadmap curiosity.
- `supports`, `contradicts`, `evaluates`, `derived_from`, and `supersedes` may
  participate in feedback structures subject to their own validation rules.
- A generated dependency DAG contains only edge kinds declared by its
  projection contract. It is not the canonical graph.

## Exact references

Every transition has a nonempty set of basis references. References are typed,
not arbitrary URLs or prose.

The first tracer supports these reference families:

### Git commit

A Git reference contains:

- a canonical repository identity;
- Git object format;
- a full immutable object ID;
- an optional path or artifact identity within that commit; and
- the observation that established object availability.

A branch or tag may be shown as context but is never the immutable subject.

### Artifact

An artifact reference contains:

- digest algorithm and digest;
- media or schema type;
- producing operation or event when known; and
- storage locator as non-authoritative retrieval metadata.

### Machine check

A machine-check reference contains:

- checker identity and version or digest;
- exact subject references;
- policy or acceptance-contract identity;
- command or operation identity;
- relevant environment/toolchain identity;
- result and exit disposition;
- output or log digest; and
- observation time.

A passing exit code alone does not establish that the intended contract,
subject, or complete journey was checked.

### External record

An imported record contains:

- provider and repository/project identity;
- provider record identity;
- immutable revision or observed version when the provider exposes one;
- observation time; and
- explicitly limited interpretation.

An external issue's `done` status is an observation about that provider, not an
automatic Workgraph completion transition.

### Human approval

A human approval contains:

- actor identity;
- authentication strength, including `unverified` when appropriate;
- authority scope or role;
- exact subject references;
- the transition or claim approved;
- rationale;
- approval time; and
- optional signature or provider record.

Its evidence category is `human_approved_assertion`. It must expose
`machine_checked: false`. Authentication of the actor, when present, does not
turn the approved proposition into a machine-derived fact.

### Graph event

A graph-event reference contains the stable identity of an earlier canonical
event. Later corrections reference and supersede an earlier event rather than
deleting it.

## Transition contract

Canonical lifecycle state is reduced from transition events. There is no
general-purpose mutable `status` field.

Every transition event contains:

- stable event identity;
- exact subject identity;
- prior and requested lifecycle state;
- transition kind;
- actor or automation identity;
- authority kind;
- evidence category;
- nonempty basis references;
- policy identity and version;
- rationale or derivation explanation;
- observation time; and
- supersession reference when correcting an earlier event.

The initial authority kinds are:

- `machine_policy`;
- `human_approval`;
- `imported_observation`; and
- `administrative_assertion`.

The initial evidence categories are:

- `machine_check`;
- `human_approved_assertion`;
- `external_observation`;
- `agent_assertion`; and
- `assumption`.

Authority and evidence category are separate dimensions. In particular:

- an agent summary defaults to `agent_assertion`;
- a commit defaults to an artifact reference;
- a review defaults to an assertion unless its machine-checkable portions are
  separately recorded;
- a test result is `machine_check` only when its checker, exact subject,
  contract, environment, and result are bound; and
- a human decision remains `human_approved_assertion` even when the actor's
  identity is cryptographically authenticated.

An untyped or reference-free transition is invalid and cannot enter canonical
history.

## Commit and transition ordering

Git commits cannot contain their own object IDs. The model must not introduce a
self-reference fiction.

Two valid flows are supported:

### Evidence-first transition

1. A work commit or artifact already exists.
2. Checks and approvals reference that exact subject.
3. A later canonical transition event references those immutable facts.
4. If the canonical store itself is Git-backed, the event appears in a later
   graph commit.

### Commit-declared transition request

1. A commit contains a transition request with stable subject/work identities,
   but does not pretend to know its own future Git object ID.
2. An observer sees the resulting immutable commit.
3. The observer emits a separate canonical event referencing that commit.
4. Policy validates the request, basis, and authority before deriving state.

A commit may therefore request or launch evaluation of a transition. It does
not silently certify the transition merely by existing.

## Declared, observed, and derived state

The model distinguishes:

- authored intent, such as priority, ownership, or a requested lifecycle move;
- observed facts, such as a commit, session, external status, or check run;
- asserted judgments, such as human approval or agent review;
- accepted canonical transition history; and
- derived state calculated from graph structure, policy, and accepted events.

The first roadmap projection derives:

- `locked`;
- `available`;
- `active`;
- `waiting`;
- `blocked`;
- `achieved`;
- `stale`; and
- `invalid`.

These values are projections, not mutable canonical facts.

Every derived value includes:

- subject identity;
- derived value;
- policy identity;
- canonical source revision or digest;
- named rules that fired;
- source nodes, edges, and events;
- unsatisfied prerequisites or conflicting facts; and
- limitations or assumptions.

## Capability-roadmap projection

The roadmap presents validated capability acquisition rather than ticket
throughput.

A capability may be displayed at these distinct maturity levels:

1. unexplored;
2. researched;
3. specified;
4. executable tracer observed;
5. independently reviewed;
6. integrated; and
7. operationally observed.

These levels are not interchangeable evidence categories. A later level does
not manufacture proof, and an earlier formal result does not establish
operational suitability.

The projection supports:

- AND prerequisites;
- alternative OR realization paths;
- optional branches;
- explicitly abandoned or contradicted routes;
- capability unlocks;
- milestone acceptance envelopes; and
- the currently available frontier.

Recommendations such as "highest-leverage available work" must show the rule,
weights, assumptions, and downstream nodes used. The engine must not present a
heuristic score as semantic authority.

## Required projections

The first tracer deterministically emits:

- canonical normalized graph JSON;
- capability-roadmap JSON;
- Mermaid capability roadmap;
- dependency-schedule JSON;
- milestone/status Markdown;
- a machine-readable transition explanation; and
- a drift manifest binding every view to its canonical revision or digest.

Generated files are disposable. Editing one and running the drift gate must
fail.

## Runtime and integration boundary

- The portable graph, transition, policy, and derivation core has no direct
  filesystem, process, network, clock, random, GitHub, Herdr, Bun, Node, Deno,
  or Semantic Systems authority.
- Capabilities are injected and interpreted at composition roots.
- Bun is the default runtime and package manager.
- Node is supported through an equivalent live-layer composition.
- Effect v4 is the default for effectful services, typed failures, resources,
  concurrency, telemetry, and adapter composition.
- Runtime execution is absent from import-time module evaluation.
- Adapters may observe Git, GitHub, CI, Herdr, files, or other systems, but
  observations become canonical only through the transition policy boundary.

## Independence from Semantic Systems

The first tracer may use a small fictional project fixture inspired by real
agent work, but:

- no Semantic Systems module is imported;
- no theory, realization, proof, or evidence-category semantics are assumed;
- no Semantic Systems repository path is required;
- Workgraph core types remain domain-neutral; and
- Semantic Systems integration, when later attempted, is a separate adapter
  and consumer acceptance journey.

## Security and trust boundaries

- A repository URL is not an authenticated identity by itself.
- A commit's existence does not establish authorship, review, correctness, or
  execution.
- A GitHub check conclusion is not trusted without exact repository, commit,
  workflow/check identity, and observation binding.
- Agent and human prose is assertion evidence.
- Human authority may legitimately approve a transition that is not
  machine-checkable, but the resulting state must preserve that fact.
- Imported records retain their provider and observation limitations.
- The first tracer makes no claim of signature verification, remote
  authentication, distributed consensus, or tamper-proof storage.

## Tracer fixture

The committed fixture contains:

- one research question;
- one frozen design;
- one implementation experiment;
- one exact Git-commit reference;
- one passing machine check bound to that commit;
- one human-approved assertion over a distinct transition;
- one capability unlocked through an AND gate;
- one alternative capability path;
- one failing operational observation that contradicts an assumption and
  creates a feedback edge;
- one milestone acceptance envelope;
- one active agent-session observation; and
- at least one legal canonical feedback cycle.

## Acceptance

The first implementation is accepted only when executable checks establish all
of the following:

1. The fixture validates and every canonical transition has at least one typed
   exact basis reference.
2. Removing or weakening a commit object ID makes the dependent transition
   invalid.
3. A branch name alone cannot satisfy an exact-subject requirement.
4. A machine check bound to commit A cannot unlock the artifact from commit B.
5. A human-approved transition is accepted when policy permits it, but every
   generated view labels it as a human-approved assertion and
   `machine_checked: false`.
6. An agent's untyped "done" assertion cannot satisfy a machine-check gate.
7. A commit-declared transition request produces no state change until a
   separate observer event references the immutable resulting commit.
8. Correcting a transition creates a superseding event and preserves the prior
   event.
9. The canonical graph accepts the fixture's legal feedback cycle.
10. A `requires` or `contains` cycle fails the applicable projection.
11. The roadmap derives locked, available, active, achieved, stale, and blocked
    nodes with source-level explanations.
12. AND and OR prerequisites unlock exactly the intended capability paths.
13. Every projection carries the same canonical revision or digest.
14. Editing a generated projection makes the drift check fail.
15. Bun and Node produce byte-equivalent normalized and derived bounded
    observations.
16. The portable core's transitive import closure reaches no runtime,
    filesystem, process, network, clock, random, GitHub, Herdr, or Semantic
    Systems capability.
17. No unsupported proof, authentication, execution, or operational-suitability
    claim appears in any projection.

### Executable acceptance commands

The completion head must pass these exact commands from a clean checkout:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run accept:0001
git diff --check
git status --short
```

`bun run check` owns formatting, lint, type checking, portable-core import
closure, and the complete bounded test suite. `bun run accept:0001` owns the
observable Bun/Node tracer journey, byte-equivalence comparison, generated-view
drift check, and acceptance-item evidence manifest. A missing runtime or tool is
a failure, never a warning.

## Falsifiers

The design is rejected or explicitly revised if:

- a state transition can enter canonical history without an exact basis;
- human approval can be rendered as machine verification;
- current state is stored independently from transition history and can drift;
- an adapter can mutate lifecycle state without policy evaluation;
- a derived recommendation cannot explain its source rules and references;
- the dependency view is treated as the canonical graph;
- generated views require manual synchronization;
- the Git-backed flow relies on a commit knowing its own future identity;
- the core requires Semantic Systems or one external provider; or
- the first user journey requires a hosted service.

## Non-goals

- A hosted SaaS control plane.
- A universal ontology for every project-management methodology.
- Bidirectional synchronization with every issue tracker.
- Replacing Git, GitHub, Herdr, or CI.
- Gamified points or opaque productivity scoring.
- Cryptographic proof of human intent.
- Formal verification of the reducer in the first tracer.
- Pagu integration.

## Deliverables

- one portable canonical model and transition reducer;
- one policy and derivation engine;
- one local store suitable for the tracer;
- one Bun CLI and equivalent Node composition;
- the committed tracer fixture;
- deterministic roadmap, schedule, report, explanation, and drift projections;
- focused adversarial tests for every acceptance item;
- a provenance and evidence-limit report; and
- one public completion PR bound 1:1 to this design spec.
