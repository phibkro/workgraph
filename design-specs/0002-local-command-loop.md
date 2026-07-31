# Design spec 0002: local command loop

Status: frozen second recut for implementation

Date: 2026-07-31

Base: `ba9fecdd56a3a0b592604e79b55715363e6ee5f3`

Rejected contract head: `24a8e3a243a414f46dc5279c3723ea6bd7bd19b7`

Rejected first recut: `800d0f1e998e6c61dfb5f123aaf1aa244b4707d7`

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
  readonly eventChainDigest: `sha256:${string}`;
  readonly genesis: {
    readonly staticGraphDigest: `sha256:${string}`;
    readonly graphDigest: `sha256:${string}`;
    readonly eventChainDigest: `sha256:${string}`;
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
  readonly priorEventChainDigest: `sha256:${string}`;
  readonly resultEventChainDigest: `sha256:${string}`;
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

The static graph digest covers normalized non-event graph state:

```ts
const normalized = normalizeGraph(graph);
sha256(
  stableStringify({
    schemaVersion: "workgraph.local-static-graph/v1alpha1",
    graphSchemaVersion: graph.schemaVersion,
    nodes: normalized.nodes,
    edges: normalized.edges,
    requests: normalized.requests,
  }),
);
```

The empty event-chain digest covers this value:

```ts
sha256(
  stableStringify({
    schemaVersion: "workgraph.event-chain-empty/v1alpha1",
    staticGraphDigest,
  }),
);
```

An event digest is the SHA-256 digest of these UTF-8 bytes:

```ts
stableStringify(document.graph.events[eventIndex]);
```

Each event updates the chain with this exact value:

```ts
sha256(
  stableStringify({
    schemaVersion: "workgraph.event-chain-step/v1alpha1",
    priorEventChainDigest,
    eventIndex,
    eventDigest,
  }),
);
```

The local graph digest covers this exact value:

```ts
sha256(
  stableStringify({
    schemaVersion: "workgraph.local-graph-identity/v1alpha1",
    staticGraphDigest,
    eventChainDigest,
    eventCount,
  }),
);
```

Each displayed object uses `stableStringify` and UTF-8 bytes before SHA-256.
The digest does not cover the envelope or receipts.

Initialization scans each genesis event once. It stores the chain digest after
the last genesis event.

Receipt validation continues from the genesis chain. Each receipt supplies
one event digest, one prior chain digest, and one result chain digest.

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
8. Each prior chain digest equals the preceding result chain digest.
9. Each result chain digest equals one chain-step calculation.
10. Each prior graph digest equals one graph-identity calculation.
11. Each result graph digest equals one graph-identity calculation.
12. The genesis chain and graph digests match the genesis event boundary.
13. The last result chain digest equals the envelope chain digest.
14. The last result graph digest equals the envelope graph digest.
15. If receipts are empty, both genesis digests equal both envelope digests.

The loader calculates the static digest once. It serializes each event once.
It advances the event chain once for each event.

The loader calculates each graph identity once at the genesis boundary and
once after each receipt. It reuses one boundary value as the next prior value.

The complete custody check uses at most `3 * graph.events.length + 4` SHA-256
calls. Its storage is linear in decoded input size.

The public event limit is 1,000. The acceptance suite injects a counting digest
service. It establishes the hash-call bound at 1,000 events.

Nodes, edges, and requests must equal their genesis static digest throughout
tracer 0002. Each successful transition changes the graph by one event append.

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
- more than 8 MiB of source bytes
- nesting deeper than 64 levels
- more than 1,000 events
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
      readonly receiptSeed: Omit<
        AppendReceipt,
        "eventDigest" | "resultEventChainDigest" | "resultGraphDigest"
      >;
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
12. Append the event to a new graph value.
13. Preserve every earlier event by equal semantic value and order.
14. Validate the complete candidate graph with the resolved registry.
15. If validation fails, return `Rejected`.
16. Prepare the next revision, event index, and receipt seed.
17. Return `Apply` with the candidate graph and receipt seed.

The exact duplicate result does not depend on the current registry or graph
identity. It reports the prior receipt and performs no effect.

If a duplicate key has different command bytes, its conflict takes precedence
over all stale-identity conflicts. This order is deterministic.

There is no `Number.MAX_SAFE_INTEGER` exhaustion decision. The decoder rejects
unsafe integers. Candidate validation returns `input_bound_exceeded` when one
append exceeds a public collection limit.

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

Temporary files, the lock file, and the target use the same retained root
device. Replacement cannot cross a filesystem boundary.

The adapter prepares a complete token-bound lock record in an exclusive
temporary file. It writes and synchronizes the record before publication.

An atomic hard link publishes the public sibling lock name. Existing-lock
failure returns `Busy`. After publication, the adapter removes the temporary
lock name and synchronizes the root.

The public lock record is therefore absent or complete. Atomic link publication
grants exclusive custody.

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

Initialization acquires the normal sibling lock. Its lock record has this
logical content:

```ts
interface GenesisPublicationRecord {
  readonly schemaVersion: "workgraph.genesis-publication/v1alpha1";
  readonly operation: "init";
  readonly token: string;
  readonly targetBasename: string;
  readonly temporaryBasename: string;
  readonly documentDigest: `sha256:${string}`;
  readonly graphDigest: `sha256:${string}`;
}
```

The adapter writes and synchronizes this record before it creates the
temporary file. The temporary basename derives from the random lock token.

Before public lock publication, a fault returns `GenesisFailed`. Any residue
is an unpublished token-bound lock-record temporary file.

After public lock publication, a non-conflict failure returns
`GenesisRecoveryRequired`. This outcome applies before and after target link.

The adapter writes and synchronizes one exclusive temporary file. It creates
the target with an atomic hard link through the retained directory handle.
Existing-target creation fails without a target change.

The adapter synchronizes the root, unlinks the temporary name, synchronizes the
root again, and inspects the target. The final target must have link count one.

The publication protocol has these crash states:

| State           | Target                  | Temporary               | Required next action      |
| --------------- | ----------------------- | ----------------------- | ------------------------- |
| `PreparedEmpty` | absent                  | absent                  | abort                     |
| `Prepared`      | absent                  | exact, one link         | finalize or abort         |
| `Linked`        | exact, shared two links | exact, shared two links | finalize                  |
| `Published`     | exact, one link         | absent                  | finalize sync and release |
| `Conflicted`    | any other combination   | any other combination   | stop without cleanup      |

An uncertain link result triggers an immediate handle-relative observation. If
that observation fails, the result is `GenesisRecoveryRequired`.

The four non-conflict rows are disjoint. Link count, device, inode, document
digest, and basename determine the row. Every other observation is
`Conflicted`.

`GenesisRecoveryRequired` includes the lock-record digest, document digest,
current custody basename, target observation, temporary observation, and
cleanup residue. It never claims that publication failed or completed.

The public recovery API is:

```ts
recoverGenesisPublication({
  root,
  targetBasename,
  custodyBasename,
  expectedLockRecordDigest,
  expectedDocumentDigest,
  action: "finalize" | "abort",
});
```

The CLI is:

```text
workgraph init recover --root <dir> --file <basename> --custody <basename> --lock-digest <sha256> --document-digest <sha256> --action <finalize|abort>
```

Recovery requires explicit operator authority. It first compares the complete
lock record, custody basename, and both expected digests.

The first recovery uses the public lock basename. A recovery fault returns the
token-bound recovery basename for the next exact call.

Recovery atomically renames the lock file to a token-bound recovery name.
Every normal writer checks the public lock name before each mutating boundary.
If that name disappears, the writer stops.

For `finalize`, recovery performs these rules:

1. If both publication names are absent, return `missing_genesis_temporary`.
2. If only the exact temporary file exists, link it to the absent target.
3. If both names identify the same exact file, synchronize the root.
4. Remove the exact temporary name.
5. Synchronize the root again.
6. Decode and inspect the target.
7. Remove any exact token-bound lock-record temporary name.
8. Remove the seized recovery lock by exact token.

For `abort`, recovery performs these rules:

1. If an exact target exists, return `Conflict` with `genesis_already_linked`.
2. Remove only the exact temporary file.
3. Synchronize the root.
4. Remove any exact token-bound lock-record temporary name.
5. Remove the seized recovery lock by exact token.

Any other file identity returns `Conflict` without unlinking it. A recovery
fault returns `GenesisRecoveryRequired` with the new observed state.

Recovery returns `GenesisRecovered` with disposition `finalized` or `aborted`.
The outcome includes the final target observation and residue list.

This protocol coordinates only writers that obey the lock checks. Operator
recovery is a human-authorized local action, not proof that the first writer
terminated.

## Outcomes

Every API and CLI result uses one of these tags:

| Tag                       | Meaning                                                                 | Target can differ from the initial observation |
| ------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- |
| `Initialized`             | A new coherent genesis document was linked, synced, and inspected.      | New target only                                |
| `GenesisFailed`           | Genesis stopped before public custody or target publication.            | No target change by this command               |
| `GenesisRecovered`        | Exact recovery finalized or aborted a known genesis publication.        | Reported by disposition                        |
| `GenesisRecoveryRequired` | Genesis publication or recovery needs exact operator continuation.      | Reported by target observation                 |
| `Inspected`               | The document was decoded and identified.                                | No                                             |
| `Applied`                 | Rename, directory sync, and read-back matched the result identity.      | Yes                                            |
| `AlreadyApplied`          | The same idempotency key and command digest already have a receipt.     | No new change                                  |
| `Rejected`                | Input, policy, candidate, or path validation failed.                    | No                                             |
| `Conflict`                | Expected identity, idempotency, event identity, or custody changed.     | No command change                              |
| `Busy`                    | Another lock owns the target.                                           | Unknown external activity                      |
| `StoreFailed`             | An append operation failed before target replacement.                   | Reported by target-change knowledge            |
| `Unavailable`             | This platform cannot supply the required custody capability.            | No command change                              |
| `WriteUnknown`            | Target-replacement rename started without durable read-back.            | Unknown                                        |
| `ProjectionFailed`        | Projection publication stopped before the active-pointer rename.        | No pointer change by this command              |
| `ProjectionUnknown`       | Active-pointer rename was called without complete publication evidence. | Unknown active snapshot                        |
| `ProjectionWritten`       | All projection files carry the inspected graph digest.                  | Graph unchanged                                |

`Applied` is not proof of correctness or operational suitability. It is a
runtime observation about this local transaction.

If `WriteUnknown` occurs, the result includes the expected prior and candidate
identities. The caller must run `inspect` before it retries.

`StoreFailed` has this logical shape:

```ts
type FileObservation =
  | { readonly _tag: "Absent" }
  | {
      readonly _tag: "Exact";
      readonly device: number;
      readonly inode: number;
      readonly linkCount: number;
      readonly contentDigest: `sha256:${string}`;
    }
  | { readonly _tag: "Other"; readonly device: number; readonly inode: number }
  | { readonly _tag: "NotObserved" };

type DirectoryObservation =
  | { readonly _tag: "Absent" }
  | {
      readonly _tag: "Exact";
      readonly device: number;
      readonly inode: number;
      readonly treeDigest: `sha256:${string}`;
    }
  | { readonly _tag: "Other"; readonly device: number; readonly inode: number }
  | { readonly _tag: "NotObserved" };

interface CleanupResidue {
  readonly kind:
    | "temporary_file"
    | "lock_file"
    | "projection_staging_directory"
    | "projection_snapshot_directory"
    | "projection_pointer_file";
  readonly basename: string;
  readonly expectedIdentityOrToken: string;
}

interface StoreFailed {
  readonly _tag: "StoreFailed";
  readonly phase: StorePhase;
  readonly code: string;
  readonly priorIdentity?: GraphIdentity;
  readonly targetChangeKnowledge:
    | { readonly _tag: "UnchangedObserved"; readonly identity: GraphIdentity }
    | { readonly _tag: "ChangedExternally"; readonly identity: GraphIdentity }
    | { readonly _tag: "NotObserved" };
  readonly cleanupResidue: ReadonlyArray<CleanupResidue>;
}

interface Unavailable {
  readonly _tag: "Unavailable";
  readonly phase: "platform-check" | "root-open";
  readonly code: "unsupported_platform" | "handle_relative_paths_unavailable";
  readonly priorIdentity?: GraphIdentity;
  readonly targetChangeKnowledge: { readonly _tag: "NotObserved" };
  readonly cleanupResidue: readonly [];
}

interface GenesisRecoveryRequired {
  readonly _tag: "GenesisRecoveryRequired";
  readonly phase: GenesisPublicationPhase;
  readonly custodyBasename: string;
  readonly lockRecordDigest: `sha256:${string}`;
  readonly documentDigest: `sha256:${string}`;
  readonly targetObservation: FileObservation;
  readonly temporaryObservation: FileObservation;
  readonly cleanupResidue: ReadonlyArray<CleanupResidue>;
}

interface GenesisFailed {
  readonly _tag: "GenesisFailed";
  readonly phase: GenesisPublicationPhase;
  readonly code: string;
  readonly targetObservation: FileObservation;
  readonly temporaryObservation: FileObservation;
  readonly cleanupResidue: ReadonlyArray<CleanupResidue>;
}

interface GenesisRecovered {
  readonly _tag: "GenesisRecovered";
  readonly disposition: "finalized" | "aborted";
  readonly graphIdentity?: GraphIdentity;
  readonly targetObservation: FileObservation;
  readonly cleanupResidue: ReadonlyArray<CleanupResidue>;
}

interface ProjectionFailed {
  readonly _tag: "ProjectionFailed";
  readonly phase: ProjectionPhase;
  readonly code: string;
  readonly sourceIdentity: GraphIdentity;
  readonly priorActiveSnapshot: DirectoryObservation;
  readonly completedFiles: ReadonlyArray<{
    readonly basename: string;
    readonly digest: `sha256:${string}`;
  }>;
  readonly outputState:
    "PriorSnapshotActive" | "NoActiveSnapshot" | "OrphanSnapshotPresent" | "NotObserved";
  readonly cleanupResidue: ReadonlyArray<CleanupResidue>;
}

interface ProjectionUnknown {
  readonly _tag: "ProjectionUnknown";
  readonly phase: ProjectionPhase;
  readonly code: string;
  readonly sourceIdentity: GraphIdentity;
  readonly priorSnapshot: DirectoryObservation;
  readonly candidateSnapshot: DirectoryObservation;
  readonly pointerObservation: FileObservation;
  readonly completedFiles: ReadonlyArray<{
    readonly basename: string;
    readonly digest: `sha256:${string}`;
  }>;
  readonly cleanupResidue: ReadonlyArray<CleanupResidue>;
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
cleanup
```

`GenesisPublicationPhase` is one of:

```text
lock-record-create
lock-record-write
lock-record-sync
lock-record-publish
lock-record-cleanup
temporary-create
temporary-write
temporary-sync
target-link
first-directory-sync
temporary-unlink
final-directory-sync
target-readback
lock-seize
recovery-observe
recovery-finalize
recovery-abort
recovery-release
```

Every append fault before the target-replacement rename returns `StoreFailed`,
`Unavailable`, `Busy`, `Conflict`, or `Rejected`. The result includes the exact
phase.

`Unavailable` occurs before project-file reads or mutating effects. Its prior
identity is absent and its cleanup residue is empty.

`StoreFailed` means that the append adapter did not call target-replacement
rename. It does not claim that an external writer left the target unchanged.

If cleanup fails, `cleanupResidue` names only the exact verified objects that
can remain. An empty list means that the adapter observed no residue.

After the adapter calls target-replacement rename, it cannot return
`StoreFailed`. It returns `Applied` only after directory sync and matching
read-back. Every other failure or cancellation returns `WriteUnknown`.

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
- `src/local/projection-store.ts`: snapshot publication and inspection
- `src/local/bun-file-store.ts`: Bun live layer
- `src/local/node-file-store.ts`: Node live layer
- `src/cli/local-command.ts`: shared CLI parser and output encoder.

The public API does not accept shell strings. It does not start child
processes. Callers pass typed values and capability implementations.

The API exposes cancellation through Effect scopes. Cancellation before target
replacement returns a known pre-replacement outcome. Cancellation after that
rename call returns `WriteUnknown` unless read-back establishes `Applied`.

## CLI

The Bun composition extends `workgraph` with these commands:

```text
workgraph init --root <dir> --graph <basename> --file <basename> [--policies <basename>]
workgraph init recover --root <dir> --file <basename> --custody <basename> --lock-digest <sha256> --document-digest <sha256> --action <finalize|abort>
workgraph inspect --root <dir> --file <basename> [--policies <basename>]
workgraph append-transition --root <dir> --file <basename> --command <basename> [--policies <basename>]
workgraph project --root <dir> --file <basename> --out <basename>
workgraph project inspect --root <dir> --out <basename>
workgraph lock inspect --root <dir> --file <basename>
workgraph lock recover --root <dir> --file <basename> --lock-digest <sha256> --graph-digest <sha256>
```

The Node composition accepts the same arguments. Existing 0001 `generate` and
`check` commands keep their behavior.

The CLI writes one deterministic JSON result to standard output. It writes
diagnostics to standard error.

The exit codes are:

- `0` for `Initialized`, `GenesisRecovered`, `Inspected`, `Applied`,
  `AlreadyApplied`, and `ProjectionWritten`
- `2` for `Rejected`
- `3` for `Conflict` and `Busy`
- `4` for `WriteUnknown`
- `5` for `StoreFailed`
- `6` for `ProjectionFailed`
- `7` for `ProjectionUnknown`
- `8` for `GenesisRecoveryRequired`
- `9` for `GenesisFailed`
- `64` for invalid CLI use
- `69` for `Unavailable`.

## Read-only projections

`project` reads one accepted local document and does not change it. Every
projection carries `graphDigest` and `revision`.

The projector uses the graph digest from a fresh recalculation. It does not
trust the envelope field by itself.

The output directory is a safe direct-child basename under the retained root.
The adapter retains its directory handle for all projection writes.

Projection publication uses immutable snapshot directories. Each snapshot is a
safe direct child of the output directory.

The snapshot tree digest is SHA-256 over its deterministic manifest bytes. The
manifest binds source identity, generator identity, and every other file
digest. It excludes itself and sorts each safe file basename.

The snapshot basename is
`snapshot-<graph-digest-hex>-<tree-digest-hex>`. The active pointer is the
regular file `CURRENT`.

`CURRENT` contains deterministic JSON with the snapshot basename, graph
digest, revision, tree digest, and projection-generator identity.

The adapter performs these phases:

```text
projection-build
output-open
output-lock-acquire
staging-create
projection-file-create
projection-file-write
projection-file-sync
manifest-create
manifest-write
manifest-sync
staging-directory-sync
snapshot-publish
source-reobserve
pointer-create
pointer-write
pointer-sync
pointer-publish
output-directory-sync
projection-readback
projection-cleanup
```

The adapter writes all files to a token-bound staging directory. It writes the
digest manifest last and synchronizes the staging directory.

The adapter holds a token-bound output lock for the publication. It compares
the source graph identity again before it publishes the pointer.

It renames the staging directory to the immutable snapshot basename. If that
snapshot exists, the adapter accepts it only when every file matches. A
mismatch returns `snapshot_digest_mismatch` without a pointer change.

The adapter writes a temporary pointer file, synchronizes it, and renames it
over `CURRENT`. It then synchronizes the output directory and reads the active
snapshot back.

A failure before the `CURRENT` rename call returns `ProjectionFailed`. It
includes:

- the exact phase
- the source graph identity
- the prior active snapshot observation
- every completed staging file and digest
- the output state
- exact cleanup residue.

The output state is one of `PriorSnapshotActive`, `NoActiveSnapshot`,
`OrphanSnapshotPresent`, or `NotObserved`. Staging or orphan files never become
active projections.

After the `CURRENT` rename call, every non-success result is
`ProjectionUnknown`. It includes prior and candidate snapshot identities,
pointer observation, completed files, and cleanup residue.

`ProjectionWritten` requires pointer publication, output-directory sync, and
matching read-back of every file. It names the exact active snapshot.

The CLI inspection command is:

```text
workgraph project inspect --root <dir> --out <basename>
```

It returns the pointer, active snapshot, file digests, source graph identity,
and any verified residue. It performs no cleanup.

Projection drift compares regenerated bytes with the active snapshot. A
projection cannot serve as the expected identity for an append command.

## Agent skill

The implementation includes `skills/workgraph-local/SKILL.md`. The skill uses
the typed API or the exact CLI commands from this contract.

The skill must:

- inspect before it prepares an append command
- copy the exact revision, graph digest, and policy registry digest into the
  command
- present every outcome tag without relabeling
- report the phase and cleanup residue for `StoreFailed`
- inspect after `WriteUnknown` or `ProjectionUnknown`
- preserve all evidence from `GenesisRecoveryRequired`
- avoid an automatic mutating retry
- preserve human assertions and evidence categories
- request operator authority before lock or genesis recovery.

The skill never edits a graph document or a projection directly.

## Bounded resources and liveness

One adapter instance owns one target transaction. The sibling lock excludes
other local writers that obey this protocol.

All waits are bounded. Lock acquisition returns `Busy` without an indefinite
wait. File reads, writes, and sync operations support cancellation.

A crashed writer can leave a lock or temporary file. A later writer reports
`Busy` and does not infer that the owner is dead. Explicit lock recovery
restores progress after an operator inspects the evidence.

Genesis publication exposes exact finalize and abort recovery. Projection
inspection exposes inactive staging and orphan snapshots.

This tracer does not claim coordination with programs that ignore the lock.
The final target-identity comparison detects many such changes, but it cannot
create distributed consensus.

## Acceptance

The implementation is accepted only when executable checks establish all
items:

1. `init` creates revision `0`, an empty receipt list, and deterministic
   genesis from an arbitrary accepted graph.
2. Bun and Node produce equal genesis bytes, graph digest, event-chain digest,
   and resolved policy-registry digest.
3. Reordered equivalent optional policy definitions produce the same complete
   normalized registry digest.
4. A semantic policy-rule change produces a different registry digest.
5. A stale expected registry digest returns `policy_registry_changed` before
   an append.
6. The complete registry rejects duplicate identities and executable fields.
7. The module-global Orchard map is absent. Tracer 0001 receives its explicit
   fixture registry.
8. The 0001 fixture, behavior, generated bytes, and canonical digest remain
   unchanged.
9. The loader rejects malformed JSON, duplicate keys, hostile depth, and every
   public size-limit violation.
10. At 1,000 events, custody validation uses no more than 3,004 SHA-256
    calls and serializes each event once.
11. The loader rejects a stored static, chain, or graph digest mismatch.
12. The loader rejects duplicate receipt keys and duplicate receipt event IDs.
13. The loader rejects a noncontiguous revision, graph, or event-chain link.
14. The loader rejects a receipt bound to the wrong event index, ID, or digest.
15. The loader rejects receipt-bound event truncation or reorder that leaves
    the stored chain.
16. A valid append adds exactly one accepted event and one coherent receipt.
17. The append increments the revision and event chain exactly once.
18. Every earlier event remains equal and in the same order.
19. A correction appends and preserves the event that it supersedes.
20. A stale expected revision returns `store_revision_changed` without a write.
21. A stale expected graph digest returns `graph_digest_changed` without a
    write.
22. The same idempotency key and command digest returns `AlreadyApplied`
    without another write.
23. Exact duplicate handling stays `AlreadyApplied` after the policy file
    changes.
24. Reusing an idempotency key with different bytes returns
    `idempotency_key_reused`.
25. An existing event ID from another key returns `event_id_exists`.
26. A candidate that crosses a public collection limit returns
    `input_bound_exceeded` through the decode-to-decision journey.
27. No unreachable numeric-exhaustion result exists in the public decision
    type.
28. An unsupported transition policy returns `Rejected` without a write.
29. A policy-invalid candidate returns `Rejected` before a filesystem write.
30. Every genesis phase has a fault-injected observation. Pre-custody faults
    return `GenesisFailed`. Post-custody faults require exact recovery.
31. `PreparedEmpty`, `Prepared`, `Linked`, `Published`, and `Conflicted` states
    classify every genesis name and identity combination.
32. Exact `finalize` recovery completes `Prepared`, `Linked`, and `Published`.
33. Exact `abort` recovery removes only an unpublished exact temporary file.
34. Abort after target link returns `genesis_already_linked`.
35. Wrong recovery digests or foreign identities return `Conflict` without
    cleanup.
36. A recovery fault returns `GenesisRecoveryRequired` with fresh evidence.
37. A recovered genesis ends with one target link and no verified residue.
38. A non-Linux platform returns `Unavailable` before project-file reads.
39. Missing procfs custody returns `Unavailable` before a mutation.
40. Every graph, command, policy, output, lock, and temporary name is a safe
    direct-child basename.
41. Symbolic-link and hard-link graph, command, and policy files are rejected.
42. An ancestor swap after each asynchronous boundary cannot move a later
    effect outside the retained root.
43. Every injected pre-replacement fault returns a total known outcome with its
    exact phase and no target-replacement rename.
44. Each `StoreFailed` reports observed prior identity, target knowledge, and
    exact cleanup residue.
45. Each `Unavailable` reports its frozen empty-state fields.
46. A partial temporary write leaves the original target bytes unchanged.
47. A target change before replacement returns `Conflict` and preserves the
    external bytes.
48. Every post-replacement failure returns `WriteUnknown` unless read-back
    establishes `Applied`.
49. A leaked lock returns `Busy`. Exact operator recovery can restore progress.
50. Read-only projections carry the graph digest and revision.
51. Every projection phase before pointer publication has a fault-injected
    `ProjectionFailed` journey.
52. Partial projection files remain inactive in a staging or orphan snapshot.
53. Every pointer-publication fault returns `ProjectionUnknown` unless full
    read-back establishes `ProjectionWritten`.
54. Projection inspection resolves active snapshot and residue observations.
55. Projection drift and source-digest mismatch are detected.
56. Bun and genuine Node produce byte-equal documents, outcomes, and
    projections.
57. The portable core import closure stays free of ambient capabilities.
58. The public API starts no process and accepts no shell command string.
59. The agent skill passes the standard skill validation.
60. The skill reports every failure and unknown outcome without a success,
    sandbox, or authentication overclaim.

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
- custody validation serializes or hashes any event more than a constant number
  of times
- an accepted receipt does not extend the prior event-chain digest
- a genesis crash state has no exact finalize or abort journey
- the public decision type contains an outcome that public decoding cannot
  reach
- a registry digest omits built-ins or depends on definition order
- a stale registry reaches candidate validation instead of returning its
  exact conflict
- a filesystem error becomes an unqualified success
- a pre-rename store failure has no total phase and cleanup observation
- an operation resolves the original root path after it retains the root
  handle
- a child effect can leave the retained root or follow a child link
- an unsupported platform reads project files before `Unavailable`
- a projection failure leaves partial files in the active snapshot
- a pointer-publication uncertainty lacks a `ProjectionUnknown` observation
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
