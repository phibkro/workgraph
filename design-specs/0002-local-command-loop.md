# Design spec 0002: local command loop

Status: frozen for implementation

Date: 2026-07-31

Base: `ba9fecdd56a3a0b592604e79b55715363e6ee5f3`

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
| Document bytes    | observation                 | none until decoded         | Reject malformed or non-canonical data.                     |
| Path metadata     | observation                 | local filesystem adapter   | Reject unsafe or changed identity.                          |
| Append command    | command                     | caller requests one effect | Reject stale, duplicate-conflicting, or invalid commands.   |
| Policy registry   | assertion of accepted rules | composition root           | Reject unknown, duplicate, or malformed policy definitions. |
| Clock value       | observation                 | runtime adapter            | Use only in lock and receipt observations.                  |
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
  readonly graph: WorkGraph;
  readonly receipts: ReadonlyArray<AppendReceipt>;
}

interface AppendReceipt {
  readonly idempotencyKey: string;
  readonly commandDigest: `sha256:${string}`;
  readonly policyRegistryDigest: `sha256:${string}`;
  readonly eventId: string;
  readonly priorRevision: number;
  readonly priorGraphDigest: `sha256:${string}`;
  readonly resultRevision: number;
  readonly resultGraphDigest: `sha256:${string}`;
}
```

`revision` is a nonnegative safe integer. A successful append increments it by
exactly one. No other operation in this tracer changes it.

`graphDigest` is the SHA-256 digest of these exact bytes:

```ts
stableStringify(normalizeGraph(document.graph));
```

The digest uses UTF-8 bytes. It does not cover the envelope, the revision, or
the receipts. The loader recalculates the digest and rejects a mismatch.

Receipts are append-only local custody records. They are not graph events and
cannot change lifecycle state. The store writes the new event and its receipt
in one replacement.

The decoder rejects:

- invalid JSON and duplicate object keys
- an unknown envelope or graph schema
- unknown discriminants, missing fields, and extra security-sensitive fields
- unsafe integers, invalid digests, and empty identifiers
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

The implementation adds an immutable `PolicyRegistry` value. Registry
construction rejects duplicate `(id, version)` pairs and malformed rules.

The generic built-in registry contains only the current `workgraph.policy.*`
definitions. Tracer 0001 composes its existing `orchard.policy.*` definitions
through a fixture registry. Its accepted fixture behavior must not change.

The CLI can load an optional data-only policy document. This document contains
the existing rule fields. It cannot contain JavaScript, module paths, shell
commands, or callbacks.

The engine binds the selected registry digest to the command observation and
receipt evidence. The registry does not become part of the canonical graph.

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
      readonly receiptSeed: Omit<AppendReceipt, "resultGraphDigest">;
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

The function applies these rules in order:

1. If the idempotency key exists with another command digest, return
   `Conflict`.
2. If the idempotency key exists with the same command digest, return
   `AlreadyApplied`.
3. If the expected revision or digest differs, return `Conflict`.
4. If the event ID already exists, return `Conflict`.
5. Append the event to a new graph value.
6. Preserve every earlier event by byte-equivalent semantic value and order.
7. Validate the complete candidate graph with the selected registry.
8. If validation fails, return `Rejected`.
9. Prepare the next revision and a receipt seed.
10. Return `Apply` with the candidate graph and receipt seed.

The effect layer calculates the candidate graph digest. It then completes the
receipt and encodes the new envelope before it requests a write.

The function never removes, reorders, or replaces an earlier event. A
correction is a new event that uses the existing correction semantics.

## Effect and authority table

| Effect                         | Owner               | Required authority                | Returned observation     |
| ------------------------------ | ------------------- | --------------------------------- | ------------------------ |
| Read document                  | local store adapter | selected root and relative file   | bytes plus file identity |
| Read policy file               | local store adapter | selected root and relative file   | bytes plus digest        |
| Acquire lock                   | local store adapter | sibling lock path                 | acquired token or busy   |
| Create temporary file          | local store adapter | target directory                  | file identity            |
| Replace target                 | local store adapter | accepted write plan and held lock | rename result            |
| Synchronize file and directory | local store adapter | held file descriptors             | sync result              |
| Read back target               | local store adapter | selected target                   | decoded identity         |
| Write projections              | projection adapter  | selected output directory         | file digests             |

The core requests effects. Bun and Node layers interpret the same effect
interfaces. The core imports no runtime, filesystem, process, clock, random,
network, GitHub, Herdr, or Semantic Systems capability.

## Path and file custody

Each command receives one explicit root directory and one relative file path.
The adapter resolves the real root before it accesses the file.

The adapter rejects:

- an absolute file path
- an empty path or a path with `..`
- a path that resolves outside the real root
- a symbolic link in any existing path component
- a symbolic-link target
- a non-regular target
- a target with a link count other than one
- a target on another device during replacement
- a changed target identity after custody starts.

The adapter uses a sibling lock directory. Atomic directory creation grants
exclusive custody. The lock record contains a random token, the expected graph
identity, the process observation, and the observation time.

The adapter never removes an existing lock automatically. `lock inspect` is a
read-only command. `lock recover` requires an exact lock-record digest and an
exact current graph digest. The agent skill must request operator authority
before it runs `lock recover`.

## Atomic replacement protocol

The store adapter performs these steps:

1. Resolve and inspect the root, path components, and target.
2. Acquire the sibling lock.
3. Read the target again under the lock.
4. Decode the document and recalculate its identity.
5. Evaluate the pure append decision.
6. Stop without a target write for `AlreadyApplied`, `Conflict`, or `Rejected`.
7. Encode the accepted candidate with deterministic JSON.
8. Create one sibling temporary file with exclusive creation and mode `0600`.
9. Write all bytes and synchronize the temporary file.
10. Inspect the target again and compare its identity.
11. Rename the temporary file over the target.
12. Synchronize the parent directory.
13. Read, decode, and digest the target again.
14. Release the lock only when the adapter still owns its token.

The adapter preserves the original file mode when the platform supports that
operation. A partial temporary-file write never changes the target.

Cleanup can remove only the adapter's verified temporary file and lock. It
must not follow a link during cleanup.

## Outcomes

Every API and CLI result uses one of these tags:

| Tag                 | Meaning                                                                        | Target can differ from the initial observation |
| ------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| `Inspected`         | The document was decoded and identified.                                       | No                                             |
| `Applied`           | Rename, directory sync, and read-back matched the result identity.             | Yes                                            |
| `AlreadyApplied`    | The same idempotency key and command digest already have a receipt.            | No new change                                  |
| `Rejected`          | Input, policy, candidate, or path validation failed.                           | No                                             |
| `Conflict`          | Expected identity, idempotency, event identity, or custody changed.            | No command change                              |
| `Busy`              | Another lock owns the target.                                                  | Unknown external activity                      |
| `WriteUnknown`      | The adapter observed a rename attempt but did not establish durable read-back. | Unknown                                        |
| `ProjectionWritten` | All projection files carry the inspected graph digest.                         | Graph unchanged                                |

`Applied` is not proof of correctness or operational suitability. It is a
runtime observation about this local transaction.

If `WriteUnknown` occurs, the result includes the expected prior and candidate
identities. The caller must run `inspect` before it retries.

The implementation never retries a mutating command automatically. It can
retry bounded read-only observations.

## Public API

The implementation owns these modules:

- `src/core/policy-registry.ts`: immutable registry construction and lookup
- `src/core/local-command.ts`: local document types and pure append decision
- `src/local/document-codec.ts`: bounded runtime decoding and deterministic
  encoding
- `src/local/store.ts`: Effect service, typed failures, and custody workflow
- `src/local/bun-file-store.ts`: Bun live layer
- `src/local/node-file-store.ts`: Node live layer
- `src/cli/local-command.ts`: shared CLI parser and output encoder.

The public API does not accept shell strings. It does not start child
processes. Callers pass typed values and capability implementations.

The API exposes cancellation through Effect scopes. Cancellation before rename
leaves the target unchanged. Cancellation at or after rename returns
`WriteUnknown` unless read-back establishes the final identity.

## CLI

The Bun composition extends `workgraph` with these commands:

```text
workgraph inspect --root <dir> --file <relative-json> [--policies <relative-json>]
workgraph append-transition --root <dir> --file <relative-json> --command <relative-json> [--policies <relative-json>]
workgraph project --root <dir> --file <relative-json> --out <relative-dir>
workgraph lock inspect --root <dir> --file <relative-json>
workgraph lock recover --root <dir> --file <relative-json> --lock-digest <sha256> --graph-digest <sha256>
```

The Node composition accepts the same arguments. Existing 0001 `generate` and
`check` commands keep their behavior.

The CLI writes one deterministic JSON result to standard output. It writes
diagnostics to standard error.

The exit codes are:

- `0` for `Inspected`, `Applied`, `AlreadyApplied`, and `ProjectionWritten`
- `2` for `Rejected`
- `3` for `Conflict` and `Busy`
- `4` for `WriteUnknown`
- `64` for invalid CLI use.

## Read-only projections

`project` reads one accepted local document and does not change it. Every
projection carries `graphDigest` and `revision`.

The projector uses the graph digest from a fresh recalculation. It does not
trust the envelope field by itself.

The output directory is a relative path under the selected root. The adapter
applies the same path and link restrictions to projection writes.

Projection drift compares regenerated bytes with existing files. A projection
cannot serve as the expected identity for an append command.

## Agent skill

The implementation includes `skills/workgraph-local/SKILL.md`. The skill uses
the typed API or the exact CLI commands from this contract.

The skill must:

- inspect before it prepares an append command
- copy the exact revision and graph digest into the command
- present `Rejected`, `Conflict`, `Busy`, and `WriteUnknown` without relabeling
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

1. A valid arbitrary local document decodes under Bun and Node.
2. Both runtimes calculate the same canonical graph digest and revision.
3. The loader rejects malformed JSON, duplicate keys, hostile depth, and
   bounded-size violations.
4. The loader rejects a stored graph digest that does not match the graph.
5. A valid append command adds exactly one accepted event and one receipt.
6. The append increments the revision exactly once.
7. Every event before the append remains equal and in the same order.
8. A correction appends and preserves the event that it supersedes.
9. A stale expected revision returns `Conflict` without changing target bytes.
10. A stale expected graph digest returns `Conflict` without changing target
    bytes.
11. The same idempotency key and command digest returns `AlreadyApplied`
    without another write.
12. The same idempotency key with different command bytes returns `Conflict`.
13. An existing event ID returns `Conflict`.
14. An unsupported policy returns `Rejected` without changing target bytes.
15. A malformed or policy-invalid candidate returns `Rejected` before a
    filesystem write.
16. A policy registry rejects duplicate identities and cannot contain code.
17. The 0001 Orchard fixture and all 0001 generated bytes remain unchanged.
18. Absolute paths, path escape, symbolic links, and hard links are rejected.
19. A partial temporary write leaves the original target bytes unchanged.
20. A target change before rename returns `Conflict` and preserves the
    external bytes.
21. A failure after a possible rename returns `WriteUnknown` with both
    identities.
22. Cancellation follows the before-rename and after-rename outcome rules.
23. A leaked lock returns `Busy`; exact operator recovery can restore
    progress.
24. Read-only projections carry the recalculated graph digest and revision.
25. Projection drift and source-digest mismatch are detected.
26. Bun and genuine Node produce byte-equivalent document and projection
    results.
27. The portable core import closure stays free of ambient capabilities.
28. The public API starts no process and accepts no shell command string.
29. The agent skill passes the standard skill validation.
30. The agent skill reports a bounded `WriteUnknown` journey without a
    success, sandbox, or authentication overclaim.

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

The focused suite owns fault-injected store tests, path adversaries, runtime
parity, and the skill journey. A missing runtime or tool is a failure.

## Falsifiers

The design is rejected or revised if:

- a command can mutate a graph without the expected prior identity
- the engine writes before it validates the complete candidate
- an accepted append changes any earlier event
- a correction erases or rewrites its target
- a duplicate command creates a second event or revision
- a filesystem error becomes an unqualified success
- a path can leave the selected root or follow a link
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
