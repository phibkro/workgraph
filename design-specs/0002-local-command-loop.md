# Design spec 0002: local command loop

Status: frozen recut for implementation

Date: 2026-07-31

Base: `ba9fecdd56a3a0b592604e79b55715363e6ee5f3`

Rejected contract head: `24a8e3a243a414f46dc5279c3723ea6bd7bd19b7`

## Problem

Tracer 0001 proves the graph and projection semantics with one committed
fictional fixture. It does not load or update a user-selected graph document.
An operator must edit TypeScript to use Workgraph with another project.

Direct JSON editing is not a safe update protocol. Two writers can overwrite
each other. A failed write can truncate the only document. A generated view can
also drift from the graph that it claims to describe.

## Goal

Provide one bounded local command loop for an arbitrary Workgraph project.

The loop must:

1. Load and decode a user-selected document.
2. Calculate its exact graph digest and store revision.
3. Accept one digest-bound append command.
4. Apply an explicit policy registry.
5. Validate the complete candidate graph before a filesystem effect.
6. Preserve the exact event prefix.
7. Replace the document atomically on one filesystem.
8. Return an explicit observation.
9. Generate read-only projections that carry the source graph digest.

The implementation keeps the semantics and fixture of tracer 0001 unchanged.

## Semantic boundary

```text
document bytes + path observation + append command + policy registry
                              |
                              v
                 decoded and warranted state
                              |
                 +------------+------------+
                 |                         |
                 v                         v
          returned decision          typed write plan
                 |                         |
                 +------------+------------+
                              v
                  atomic store replacement
                              |
                              v
              read-back observation and projections
```

The graph is canonical truth. The store envelope holds local concurrency and
idempotency facts. Projections are derived artifacts.

## Input inventory

| Input             | Class                       | Authority                  | Rejection rule                                              |
| ----------------- | --------------------------- | -------------------------- | ----------------------------------------------------------- |
| Document bytes    | observation                 | opened-root capability     | Reject malformed or incoherent data.                        |
| Command bytes     | command source              | opened-root capability     | Reject malformed or changed command files.                  |
| Path metadata     | observation                 | local filesystem adapter   | Reject unsafe or changed identity.                          |
| Append command    | command                     | caller requests one effect | Reject stale, duplicate-conflicting, or invalid commands.   |
| Policy registry   | assertion of accepted rules | composition root           | Reject unknown, duplicate, or malformed policy definitions. |
| Clock value       | observation                 | runtime adapter            | Use only in lock observations.                              |
| Random lock token | observation                 | runtime adapter            | Use only for exclusive custody.                             |
| Write result      | observation                 | local filesystem adapter   | Never infer success from intent.                            |

An append command is not an event until the engine accepts it and the store
commits the candidate document.

## Local document

The JSON envelope has this logical TypeScript shape:

```ts
interface LocalWorkGraphDocument {
  readonly schemaVersion: "workgraph.local/v1alpha1";
  readonly revision: number;
  readonly graphDigest: `sha256:${string}`;
  readonly genesis: {
    readonly graphDigest: `sha256:${string}`;
    readonly eventCount: number;
  };
  readonly graph: WorkGraph;
  readonly receipts: ReadonlyArray<AppendReceipt>;
}

interface AppendReceipt {
  readonly idempotencyKey: string;
  readonly commandDigest: `sha256:${string}`;
  readonly policyRegistryDigest: `sha256:${string}`;
  readonly eventId: string;
  readonly eventIndex: number;
  readonly eventDigest: `sha256:${string}`;
  readonly priorRevision: number;
  readonly priorGraphDigest: `sha256:${string}`;
  readonly resultRevision: number;
  readonly resultGraphDigest: `sha256:${string}`;
}
```

`workgraph init` creates deterministic genesis from one decoded `WorkGraph`.
Genesis has revision `0`, no receipts, and the current event count. Both
genesis and current graph digests equal the digest of the input graph.

Initialization adds no clock, random value, process identity, or filesystem
path to the document. Equal graph and registry inputs produce equal document
bytes under Bun and Node.

`revision` equals `receipts.length`. It is a nonnegative safe integer. One
successful append increments it by exactly one.

`graphDigest` is the SHA-256 digest of these exact bytes:

```ts
stableStringify(normalizeGraph(document.graph));
```

The digest uses UTF-8 bytes. It does not cover the envelope, the revision, or
the receipts. The loader recalculates the digest and rejects a mismatch.

An event digest is the SHA-256 digest of these UTF-8 bytes:

```ts
stableStringify(document.graph.events[eventIndex]);
```

For receipt validation, graph prefix `n` is the final graph value with
`events.slice(0, n)`. Its nodes, edges, and requests stay unchanged.

Receipts are append-only local custody records. They contain no clock field.
Receipt order and revision establish their order.

A coherent document satisfies all rules:

1. `revision === receipts.length`.
2. The sum of genesis event count and revision is a safe integer.
3. `graph.events.length === genesis.eventCount + revision`.
4. Receipt keys and receipt event IDs are unique.
5. Receipt `i` has prior revision `i` and result revision `i + 1`.
6. Receipt `i` has event index `genesis.eventCount + i`.
7. The event at that index has the receipt event ID and event digest.
8. Each prior digest equals the graph digest at the prior event prefix.
9. Each result digest equals the graph digest at the result event prefix.
10. The genesis digest equals the graph digest at the genesis event prefix.
11. If receipts exist, the last result digest equals the envelope graph digest.
12. If receipts are empty, the genesis digest equals the envelope graph digest.

The loader reconstructs each prefix from the final graph. Nodes, edges, and
requests must therefore equal their genesis values throughout tracer 0002.
Each successful 0002 transition changes the graph by one event append only.

The store writes the new event and its receipt in one replacement. It rejects
an incoherent receipt chain before it evaluates a command.

Receipt coherence detects a changed receipt-bound suffix. It detects removal
or reorder when the stored chain remains.

It cannot detect replay of an earlier complete coherent envelope by itself.
The expected revision and digest detect that replay for a caller that observed
the later identity.

The decoder rejects:

- invalid JSON and duplicate object keys
- an unknown envelope or graph schema
- unknown discriminants, missing fields, and extra security-sensitive fields
- unsafe integers, invalid digests, and empty identifiers
- a revision or event count above `Number.MAX_SAFE_INTEGER`
- more than 8 MiB of source bytes
- nesting deeper than 64 levels
- more than 100,000 combined nodes, edges, events, requests, and receipts
- any graph that the selected policy registry rejects.

The decoder returns structured issues with JSON paths. It does not return a
partly decoded graph.

## Append command

The command has this logical shape:

```ts
interface AppendTransitionCommand {
  readonly schemaVersion: "workgraph.command.append-transition/v1alpha1";
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly expectedGraphDigest: `sha256:${string}`;
  readonly expectedPolicyRegistryDigest: `sha256:${string}`;
  readonly event: TransitionEvent;
}
```

The command digest is the SHA-256 digest of the UTF-8 bytes from
`stableStringify(command)`.

The idempotency key is an opaque nonempty string of at most 256 UTF-8 bytes.
The engine compares the command digest when it finds an existing key.

## Policy registry

Policy selection is an explicit input to validation. The portable core must
not use a hidden mutable registry.

The implementation adds an immutable `ResolvedPolicyRegistry` value. Its input
is the complete generic built-in list plus one optional data-only definition
list.

The generic built-in registry contains only the current `workgraph.policy.*`
definitions. Optional definitions cannot replace a built-in `(id, version)`
pair.

The CLI can load an optional data-only policy document. This document contains
the existing rule fields. It cannot contain JavaScript, module paths, shell
commands, or callbacks.

The optional document has this shape:

```ts
interface PolicyDefinitionsDocument {
  readonly schemaVersion: "workgraph.policy-definitions/v1alpha1";
  readonly definitions: ReadonlyArray<TransitionPolicyDefinition>;
}

interface ResolvedPolicyRegistry {
  readonly schemaVersion: "workgraph.resolved-policy-registry/v1alpha1";
  readonly definitions: ReadonlyArray<TransitionPolicyDefinition>;
  readonly digest: `sha256:${string}`;
}
```

Registry resolution performs these exact steps:

1. Decode the optional policy document with the common input bounds.
2. Concatenate generic built-ins before optional definitions.
3. Reject duplicate `(id, version)` pairs in the complete list.
4. Reject unknown keys, values, authorities, categories, and lifecycle rules.
5. Reject a duplicate semantic rule tuple inside one definition.
6. Normalize every rule by its complete semantic tuple.
7. Sort rules by code-unit order of that tuple.
8. Sort definitions by code-unit order of `(id, version)`.
9. Encode the complete resolved digest-scope value with `stableStringify`.
10. Calculate SHA-256 over those UTF-8 bytes.

The normalized value has this digest scope:

```ts
stableStringify({
  schemaVersion: "workgraph.resolved-policy-registry/v1alpha1",
  definitions: normalizedCompleteDefinitions,
});
```

The `digest` field of `ResolvedPolicyRegistry` is not inside its digest scope.

The rule tuple is:

```text
priorState(null sorts first), requestedState, transitionKind
```

Each normalized definition includes `id`, `version`, `authority`,
`evidenceCategory`, `rules`, and an explicit nullable `acceptanceContract`.
No source label, file path, insertion order, or object-key order enters the
digest.

The command contains `expectedPolicyRegistryDigest`. A new append compares it
with the resolved digest before it compares graph identity. A mismatch returns
`Conflict` with code `policy_registry_changed`.

The same normalized complete registry and digest must result under Bun and
Node. A reordered equivalent policy file has the same digest. A semantic rule
change has a different digest.

Tracer 0001 needs a separate explicit composition. The implementation moves
the current `orchard.policy.*` definitions to
`src/fixture/policy-registry-0001.ts`. The fixture composes them with the
generic definitions and passes that value to graph validation.

`src/core/transition-policy.ts` must remove its module-global fixture map.
Core validation and derivation receive a registry argument. All 0001 call
sites receive the explicit fixture registry.

This refactor can change source structure. It must not change 0001 accepted
behavior, public generated bytes, or the canonical fixture digest.

The engine binds the resolved registry digest to the command and receipt. The
registry does not become part of the canonical graph.

Semantic Systems vocabulary is not present in a built-in policy, schema, or
source import. A Control Room adapter is downstream work.

## Pure command decision

The portable core exposes these public concepts:

```ts
type AppendDecision =
  | {
      readonly _tag: "Apply";
      readonly candidateGraph: WorkGraph;
      readonly nextRevision: number;
      readonly receiptSeed: Omit<AppendReceipt, "eventDigest" | "resultGraphDigest">;
    }
  | { readonly _tag: "AlreadyApplied"; readonly receipt: AppendReceipt }
  | { readonly _tag: "Conflict"; readonly code: string; readonly detail: string }
  | { readonly _tag: "Rejected"; readonly issues: ReadonlyArray<ValidationIssue> };
```

The pure decision function receives:

- a fully decoded document
- its recalculated identity
- a fully decoded append command
- the command digest
- the policy registry digest
- an immutable policy registry.

The function applies these rules in exact order:

1. Make sure that the loaded receipt chain is coherent.
2. Find a receipt with the command idempotency key.
3. If its command digest matches, return `AlreadyApplied`.
4. If its command digest differs, return `Conflict` with
   `idempotency_key_reused`.
5. Compare the expected and resolved policy registry digests.
6. If they differ, return `Conflict` with `policy_registry_changed`.
7. Compare the expected and current store revisions.
8. If they differ, return `Conflict` with `store_revision_changed`.
9. Compare the expected and current graph digests.
10. If they differ, return `Conflict` with `graph_digest_changed`.
11. If the event ID exists, return `Conflict` with `event_id_exists`.
12. If the revision is `Number.MAX_SAFE_INTEGER`, return `Rejected` with
    `revision_exhausted`.
13. If the event count is `Number.MAX_SAFE_INTEGER`, return `Rejected` with
    `event_index_exhausted`.
14. Append the event to a new graph value.
15. Preserve every earlier event by equal semantic value and order.
16. Validate the complete candidate graph with the resolved registry.
17. If validation fails, return `Rejected`.
18. Prepare the next revision, event index, and receipt seed.
19. Return `Apply` with the candidate graph and receipt seed.

The exact duplicate result does not depend on the current registry or graph
identity. It reports the prior receipt and performs no effect.

If a duplicate key has different command bytes, its conflict takes precedence
over all stale-identity conflicts. This order is deterministic.

The effect layer calculates the candidate graph digest. It then completes the
receipt and encodes the new envelope before it requests a write.

The function never removes, reorders, or replaces an earlier event. A
correction is a new event that uses the existing correction semantics.

## Effect and authority table

| Effect                         | Owner               | Required authority                  | Returned observation     |
| ------------------------------ | ------------------- | ----------------------------------- | ------------------------ |
| Open root directory            | local store adapter | explicit Linux root path            | retained directory ID    |
| Read graph document            | local store adapter | retained root and direct-child name | bytes plus file identity |
| Read command file              | local store adapter | retained root and direct-child name | bytes plus file identity |
| Read policy file               | local store adapter | retained root and direct-child name | bytes plus digest        |
| Acquire lock                   | local store adapter | retained root and sibling lock name | acquired token or busy   |
| Create temporary file          | local store adapter | retained root directory             | file identity            |
| Replace target                 | local store adapter | accepted write plan and held lock   | rename observation       |
| Synchronize file and directory | local store adapter | held file and directory handles     | sync observation         |
| Read back target               | local store adapter | retained root and target name       | decoded identity         |
| Write projections              | projection adapter  | retained projection directory       | file digests             |

The core requests effects. Bun and Node layers interpret the same effect
interfaces. The core imports no runtime, filesystem, process, clock, random,
network, GitHub, Herdr, or Semantic Systems capability.

## Linux path and file custody

Tracer 0002 supports Linux only. The adapter checks `process.platform` and the
required `/proc/self/fd` behavior before it reads project inputs or requests a
mutation.

An unsupported platform returns `Unavailable` with code
`unsupported_platform`. Missing or incompatible procfs behavior returns
`Unavailable` with code `handle_relative_paths_unavailable`.

Each operation receives one explicit root path. Graph, command, policy, lock,
temporary, and projection-directory names must be safe direct-child basenames.

A safe basename:

- is 1 through 255 UTF-8 bytes
- is not `.` or `..`
- contains no slash, backslash, or NUL
- is not an absolute path.

The adapter opens the root with `O_DIRECTORY | O_NOFOLLOW`. It retains that
directory file descriptor for the complete operation. It records the root
device and inode from `fstat`.

All child operations use this capability path:

```text
/proc/self/fd/<retained-root-fd>/<safe-basename>
```

The procfs descriptor link is the only permitted link in this path. The
adapter does not resolve the original root path again after it opens the
directory.

Every child `lstat`, open, exclusive create, `mkdir`, link, rename, unlink, and
directory sync uses the retained descriptor path. Child opens use
`O_NOFOLLOW`. New files and directories use exclusive creation.

The adapter runs `fstat` on the retained root after every asynchronous
boundary. The device and inode must equal the initial root observation.

An attacker can rename or replace any ancestor of the original root path after
each boundary. The retained file descriptor still limits all later effects to
the originally opened directory.

The graph, command, and policy files must be regular direct children. Each file
must have link count one. The adapter reads each file from an open handle and
compares its final `fstat` identity with its initial identity.

The projection output directory is one safe direct child. The adapter opens or
creates it without link traversal. Projection files are safe direct children
of its retained directory handle.

Temporary files, the lock directory, and the target use the same retained root
device. Replacement cannot cross a filesystem boundary.

The adapter uses a sibling lock directory. Atomic directory creation grants
exclusive custody. The lock record contains a random token, the expected graph
identity, the process observation, and the observation time.

The adapter never removes an existing lock automatically. `lock inspect` is a
read-only command. `lock recover` requires an exact lock-record digest and an
exact current graph digest. The agent skill must request operator authority
before it runs `lock recover`.

## Atomic replacement protocol

The store adapter performs these steps:

1. Check Linux and the procfs capability path.
2. Decode all safe basenames.
3. Open and retain the root directory handle.
4. Read the command and policy files through that handle.
5. Inspect the graph target through that handle.
6. Acquire the sibling lock through that handle.
7. Read the graph target again under the lock.
8. Decode the document and recalculate all identities.
9. Resolve and digest the complete policy registry.
10. Evaluate the pure append decision.
11. Stop before a target write for all non-`Apply` decisions.
12. Calculate the candidate event and graph digests.
13. Complete the receipt and validate the final envelope coherence.
14. Encode the accepted document with deterministic JSON.
15. Create one sibling temporary file with mode `0600` and exclusive flags.
16. Write all bytes and synchronize the temporary file.
17. Apply the original target mode to the temporary file.
18. Inspect the target again and compare its file and graph identities.
19. Call rename through the retained directory capability path.
20. Synchronize the retained root directory.
21. Read, decode, and digest the target again through the retained handle.
22. Release the lock only when the adapter still owns its token.

The adapter verifies the original file mode before it applies that mode.
A partial temporary-file write never changes the target.

Cleanup can unlink only an exact temporary-file identity and exact lock token.
All cleanup uses the retained directory handle and does not follow a child
link.

## Genesis creation

`workgraph init` reads one raw `WorkGraph` and one resolved policy registry. It
validates the graph before it requests a write.

The target must not exist. Initialization never replaces a target.

The adapter writes and synchronizes one exclusive temporary file. It then
creates the target with an atomic hard link through the retained directory
handle. Existing-target creation fails without a target change.

The adapter synchronizes the root, unlinks the temporary name, and synchronizes
the root again. The final target must have link count one.

If initialization stops after link creation, its known outcome reports both
names as cleanup residue. Exact recovery can remove only the verified
temporary link.

## Outcomes

Every API and CLI result uses one of these tags:

| Tag                 | Meaning                                                                        | Target can differ from the initial observation |
| ------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| `Initialized`       | A new coherent genesis document was linked, synced, and inspected.             | New target only                                |
| `Inspected`         | The document was decoded and identified.                                       | No                                             |
| `Applied`           | Rename, directory sync, and read-back matched the result identity.             | Yes                                            |
| `AlreadyApplied`    | The same idempotency key and command digest already have a receipt.            | No new change                                  |
| `Rejected`          | Input, policy, candidate, or path validation failed.                           | No                                             |
| `Conflict`          | Expected identity, idempotency, event identity, or custody changed.            | No command change                              |
| `Busy`              | Another lock owns the target.                                                  | Unknown external activity                      |
| `StoreFailed`       | A known failure stopped the operation before a rename call.                    | Reported by target-change knowledge            |
| `Unavailable`       | This platform cannot supply the required custody capability.                   | No command change                              |
| `WriteUnknown`      | The adapter observed a rename attempt but did not establish durable read-back. | Unknown                                        |
| `ProjectionWritten` | All projection files carry the inspected graph digest.                         | Graph unchanged                                |

`Applied` is not proof of correctness or operational suitability. It is a
runtime observation about this local transaction.

If `WriteUnknown` occurs, the result includes the expected prior and candidate
identities. The caller must run `inspect` before it retries.

`StoreFailed` has this logical shape:

```ts
interface StoreFailed {
  readonly _tag: "StoreFailed";
  readonly phase: StorePhase;
  readonly code: string;
  readonly priorIdentity?: GraphIdentity;
  readonly targetChangeKnowledge:
    | { readonly _tag: "UnchangedObserved"; readonly identity: GraphIdentity }
    | { readonly _tag: "ChangedByInitialization"; readonly identity: GraphIdentity }
    | { readonly _tag: "ChangedExternally"; readonly identity: GraphIdentity }
    | { readonly _tag: "NotObserved" };
  readonly cleanupResidue: ReadonlyArray<{
    readonly kind: "temporary_file" | "lock_directory";
    readonly basename: string;
    readonly expectedIdentityOrToken: string;
  }>;
}

interface Unavailable {
  readonly _tag: "Unavailable";
  readonly phase: "platform-check" | "root-open";
  readonly code: "unsupported_platform" | "handle_relative_paths_unavailable";
  readonly priorIdentity?: GraphIdentity;
  readonly targetChangeKnowledge: { readonly _tag: "NotObserved" };
  readonly cleanupResidue: readonly [];
}
```

`StorePhase` is one of:

```text
platform-check
root-open
input-read
lock-acquire
target-read
decode
registry-resolve
decision
candidate-encode
temporary-create
temporary-write
temporary-sync
temporary-mode
target-reobserve
genesis-link
genesis-directory-sync
cleanup
```

Every fault before the rename call returns `StoreFailed`, `Unavailable`,
`Busy`, `Conflict`, or `Rejected`. The result includes the exact phase.

`Unavailable` occurs before project-file reads or mutating effects. Its prior
identity is absent and its cleanup residue is empty.

`StoreFailed` means that this adapter did not call rename. It does not claim
that an external writer left the target unchanged.

If cleanup fails, `cleanupResidue` names only the exact verified objects that
can remain. An empty list means that the adapter observed no residue.

After the adapter calls rename, it cannot return `StoreFailed`. It returns
`Applied` only after directory sync and matching read-back. Every other
failure or cancellation returns `WriteUnknown`.

The implementation never retries a mutating command automatically. It can
retry bounded read-only observations.

## Public API

The implementation owns these modules:

- `src/core/policy-registry.ts`: immutable registry construction and lookup
- `src/core/local-command.ts`: local document types and pure append decision
- `src/core/transition-policy.ts`: registry-parameterized policy evaluation
- `src/fixture/policy-registry-0001.ts`: explicit Orchard fixture composition
- `src/local/document-codec.ts`: bounded runtime decoding and deterministic
  encoding
- `src/local/store.ts`: Effect service, typed failures, and custody workflow
- `src/local/bun-file-store.ts`: Bun live layer
- `src/local/node-file-store.ts`: Node live layer
- `src/cli/local-command.ts`: shared CLI parser and output encoder.

The public API does not accept shell strings. It does not start child
processes. Callers pass typed values and capability implementations.

The API exposes cancellation through Effect scopes. Cancellation before rename
returns a known pre-rename outcome. Cancellation after the rename call returns
`WriteUnknown` unless read-back establishes `Applied`.

## CLI

The Bun composition extends `workgraph` with these commands:

```text
workgraph init --root <dir> --graph <basename> --file <basename> [--policies <basename>]
workgraph inspect --root <dir> --file <basename> [--policies <basename>]
workgraph append-transition --root <dir> --file <basename> --command <basename> [--policies <basename>]
workgraph project --root <dir> --file <basename> --out <basename>
workgraph lock inspect --root <dir> --file <basename>
workgraph lock recover --root <dir> --file <basename> --lock-digest <sha256> --graph-digest <sha256>
```

The Node composition accepts the same arguments. Existing 0001 `generate` and
`check` commands keep their behavior.

The CLI writes one deterministic JSON result to standard output. It writes
diagnostics to standard error.

The exit codes are:

- `0` for `Initialized`, `Inspected`, `Applied`, `AlreadyApplied`, and
  `ProjectionWritten`
- `2` for `Rejected`
- `3` for `Conflict` and `Busy`
- `4` for `WriteUnknown`
- `5` for `StoreFailed`
- `69` for `Unavailable`
- `64` for invalid CLI use.

## Read-only projections

`project` reads one accepted local document and does not change it. Every
projection carries `graphDigest` and `revision`.

The projector uses the graph digest from a fresh recalculation. It does not
trust the envelope field by itself.

The output directory is a safe direct-child basename under the retained root.
The adapter retains its directory handle for all projection writes.

Projection drift compares regenerated bytes with existing files. A projection
cannot serve as the expected identity for an append command.

## Agent skill

The implementation includes `skills/workgraph-local/SKILL.md`. The skill uses
the typed API or the exact CLI commands from this contract.

The skill must:

- inspect before it prepares an append command
- copy the exact revision, graph digest, and policy registry digest into the
  command
- present every outcome tag without relabeling
- report the phase and cleanup residue for `StoreFailed`
- inspect after `WriteUnknown`
- avoid an automatic mutating retry
- preserve human assertions and evidence categories
- request operator authority before lock recovery.

The skill never edits a graph document or a projection directly.

## Bounded resources and liveness

One adapter instance owns one target transaction. The sibling lock excludes
other local writers that obey this protocol.

All waits are bounded. Lock acquisition returns `Busy` without an indefinite
wait. File reads, writes, and sync operations support cancellation.

A crashed writer can leave a lock or temporary file. A later writer reports
`Busy` and does not infer that the owner is dead. Explicit lock recovery
restores progress after an operator inspects the evidence.

This tracer does not claim coordination with programs that ignore the lock.
The final target-identity comparison detects many such changes, but it cannot
create distributed consensus.

## Acceptance

The implementation is accepted only when executable checks establish all
items:

1. `init` creates revision `0`, an empty receipt list, and deterministic
   genesis from an arbitrary accepted graph.
2. Bun and Node produce equal genesis bytes, graph digest, and resolved policy
   registry digest.
3. Reordered equivalent optional policy definitions produce the same complete
   normalized registry digest.
4. A semantic policy-rule change produces a different registry digest.
5. A stale expected registry digest returns `Conflict` with
   `policy_registry_changed` before an append.
6. The complete registry rejects duplicate built-in or optional identities and
   all executable fields.
7. The module-global Orchard map is absent. Tracer 0001 receives its explicit
   fixture registry.
8. The 0001 fixture, behavior, generated bytes, and canonical digest remain
   unchanged.
9. The loader rejects malformed JSON, duplicate keys, hostile depth, and
   bounded-size violations.
10. The loader rejects a stored graph digest that does not match the graph.
11. The loader rejects duplicate receipt keys and duplicate receipt event IDs.
12. The loader rejects a noncontiguous revision or digest chain.
13. The loader rejects a receipt bound to the wrong event index, ID, or event
    digest.
14. The loader rejects receipt-bound event truncation or reorder that leaves
    the stored chain. It rejects a final receipt that differs from the
    envelope identity.
15. The loader rejects a revision, genesis event count, or result revision
    above `Number.MAX_SAFE_INTEGER`.
16. A valid append adds exactly one accepted event and one coherent receipt.
17. The append increments the revision exactly once.
18. Every event before the append remains equal and in the same order.
19. A correction appends and preserves the event that it supersedes.
20. A stale expected revision returns `store_revision_changed` without
    changing target bytes.
21. A stale expected graph digest returns `graph_digest_changed` without
    changing target bytes.
22. The same idempotency key and command digest returns `AlreadyApplied`
    without another write.
23. Exact duplicate handling stays `AlreadyApplied` after the selected policy
    file changes.
24. The same idempotency key with different command bytes returns
    `idempotency_key_reused`.
25. An existing event ID from another key returns `event_id_exists`.
26. Maximum safe revision and event index return `revision_exhausted` and
    `event_index_exhausted`, respectively.
27. An unsupported transition policy returns `Rejected` without changing
    target bytes.
28. A policy-invalid candidate returns `Rejected` before a filesystem write.
29. A non-Linux platform returns `Unavailable` before it reads project files.
30. A missing procfs capability returns `Unavailable` before a mutation.
31. Every graph, command, policy, output, lock, and temporary name must be a
    safe direct-child basename.
32. Symbolic-link and hard-link graph, command, and policy files are rejected.
33. An ancestor swap after each asynchronous boundary cannot move a later
    effect outside the retained root directory.
34. Every injected pre-rename fault returns a total known outcome with its
    exact phase and no rename call.
35. Each `StoreFailed` result reports any observed prior identity,
    target-change knowledge, and exact cleanup residue. Each `Unavailable`
    result reports its frozen empty-state fields.
36. A partial temporary write leaves the original target bytes unchanged.
37. A target change before rename returns `Conflict` and preserves the
    external bytes.
38. Every failure or cancellation after the rename call returns
    `WriteUnknown` unless full sync and read-back establish `Applied`.
39. A leaked lock returns `Busy`. Exact operator recovery can restore
    progress.
40. Read-only projections carry the recalculated graph digest and revision.
41. Projection drift and source-digest mismatch are detected.
42. Bun and genuine Node produce byte-equivalent documents, outcomes, and
    projections.
43. The portable core import closure stays free of ambient capabilities.
44. The public API starts no process and accepts no shell command string.
45. The agent skill passes the standard skill validation.
46. The skill reports `StoreFailed`, `Unavailable`, and `WriteUnknown` without
    a success, sandbox, or authentication overclaim.

### Executable acceptance commands

The completion head must pass these exact commands from a clean checkout:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run accept:0001
bun run accept:0002
git diff --check
git status --short
```

`bun run check` is the canonical full repository gate. `accept:0002` invokes
that gate and then runs the focused 0002 acceptance suite.

The canonical gate does not invoke `accept:0002`. The acceptance call graph is
nonrecursive.

The focused suite owns fault-injected store tests, path adversaries, runtime
parity, and the skill journey. A missing runtime or tool is a failure.

## Falsifiers

The design is rejected or revised if:

- a command can mutate a graph without the expected prior identity
- the engine writes before it validates the complete candidate
- an accepted append changes any earlier event
- a correction erases or rewrites its target
- a duplicate command creates a second event or revision
- a receipt chain cannot be reconstructed from genesis and event prefixes
- a registry digest omits built-ins or depends on definition order
- a stale registry reaches candidate validation instead of returning its
  exact conflict
- a filesystem error becomes an unqualified success
- a pre-rename store failure has no total phase and cleanup observation
- an operation resolves the original root path after it retains the root
  handle
- a child effect can leave the retained root or follow a child link
- an unsupported platform reads project files before `Unavailable`
- Bun and Node give different semantic results
- a projection omits the graph digest
- a policy enters through an implicit global registry
- the core imports a runtime or adjacent product
- an agent automatically retries `WriteUnknown`.

## Non-goals

- Network or hosted storage.
- Multi-file transactions.
- Distributed locks or consensus.
- Automatic stale-lock removal.
- Signature or identity verification.
- Control Room integration.
- Semantic Systems vocabulary.
- Git, GitHub, Herdr, or issue-tracker synchronization.
- A general migration framework.
- Arbitrary executable policy plugins.
- Windows atomic-replacement claims in this tracer.

## Deliverables

- the portable registry and append-decision APIs
- the bounded document codec
- Bun and Node local-store layers
- the shared local CLI commands
- deterministic digest-bound projections
- the local agent skill and usage guide
- adversarial unit and journey tests
- one clean acceptance observation bound to the completion head.
