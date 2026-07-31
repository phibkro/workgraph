import { describe, expect, test } from "bun:test";
import {
  commandDigest,
  completeAppend,
  createGenesisDocument,
  decideAppend,
  documentDigest,
  type AppendDecision,
  type AppendTransitionCommand,
  type HashFunction,
  type Sha256Digest,
  validateDocumentCoherence,
  withinPublicDocumentBounds,
} from "../src/core/local-command.ts";
import { validateGraph } from "../src/core/graph.ts";
import type { TransitionEvent, WorkGraph } from "../src/core/model.ts";
import {
  attachPolicyRegistryDigest,
  authenticatePolicyRegistry,
  resolvePolicyRegistry,
  type ResolvedPolicyRegistry,
} from "../src/core/policy-registry.ts";
import {
  decodeAppendCommand,
  decodeLocalDocument,
  decodePolicyDefinitions,
  decodeWorkGraph,
  encodeLocalDocument,
  sha256Text,
} from "../src/local/document-codec.ts";

const graph = (events: ReadonlyArray<TransitionEvent> = []): WorkGraph => ({
  schemaVersion: "workgraph/v1alpha1",
  nodes: [{ id: "work:one", kind: "work_item", title: "One" }],
  edges: [],
  events,
  requests: [],
});

const event = (id = "event:one"): TransitionEvent => ({
  id,
  subjectId: "work:one",
  priorState: null,
  requestedState: "active",
  transitionKind: "advance",
  actor: "agent:test",
  authority: "administrative_assertion",
  evidenceCategory: "agent_assertion",
  basis: [
    {
      kind: "artifact",
      algorithm: "sha256",
      digest: "a".repeat(64),
      mediaType: "application/octet-stream",
    },
  ],
  policy: "workgraph.policy.administrative",
  policyVersion: "1",
  rationale: "Start the work.",
  observedAt: "2026-07-31T00:00:00Z",
});

const resolution = resolvePolicyRegistry();
if (!resolution.ok) throw new Error("generic policy registry rejected");
const registry = attachPolicyRegistryDigest(resolution, sha256Text);
const tagOf = (value: object): unknown => Reflect.get(value, "_tag");

describe("acceptance for design spec 0002 portable slices", () => {
  test("registry normalization is order-independent and semantic changes alter scope", () => {
    const definition = {
      id: "example.policy",
      version: "1",
      authority: "administrative_assertion" as const,
      evidenceCategory: "agent_assertion" as const,
      rules: [
        {
          priorState: "active" as const,
          requestedState: "achieved" as const,
          transitionKind: "advance" as const,
        },
        { priorState: null, requestedState: "active" as const, transitionKind: "advance" as const },
      ],
    };
    const forward = resolvePolicyRegistry([definition]);
    const reversed = resolvePolicyRegistry([
      { ...definition, rules: definition.rules.toReversed() },
    ]);
    expect(forward.ok).toBeTrue();
    expect(reversed.ok).toBeTrue();
    if (!forward.ok || !reversed.ok) return;
    expect(forward.digestScope).toBe(reversed.digestScope);

    const changed = resolvePolicyRegistry([
      {
        ...definition,
        rules: [
          {
            priorState: null,
            requestedState: "achieved",
            transitionKind: "advance",
          },
        ],
      },
    ]);
    expect(changed.ok).toBeTrue();
    if (changed.ok) expect(changed.digestScope).not.toBe(forward.digestScope);
  });

  test("strict JSON rejects duplicate keys, extra fields, unsafe integers, and hostile depth", () => {
    expect(
      decodeWorkGraph('{"schemaVersion":"workgraph/v1alpha1","schemaVersion":"x"}').ok,
    ).toBeFalse();
    expect(decodeWorkGraph(JSON.stringify({ ...graph(), extra: true })).ok).toBeFalse();
    expect(
      decodeAppendCommand(
        JSON.stringify({
          schemaVersion: "workgraph.command.append-transition/v1alpha1",
          idempotencyKey: "key",
          expectedRevision: Number.MAX_SAFE_INTEGER + 1,
          expectedGraphDigest: `sha256:${"0".repeat(64)}`,
          expectedPolicyRegistryDigest: registry.digest,
          event: event(),
        }),
      ).ok,
    ).toBeFalse();
    expect(decodeWorkGraph(`${"[".repeat(66)}null${"]".repeat(66)}`).ok).toBeFalse();
  });

  test("strict JSON rejects prototype custody and non-RFC whitespace", () => {
    const validGraph = JSON.stringify(graph());
    for (const key of ["__proto__", "constructor"]) {
      expect(decodeWorkGraph(`{"${key}":${validGraph}}`).ok).toBeFalse();
      expect(decodeLocalDocument(`{"${key}":{}}`).ok).toBeFalse();
      expect(decodeAppendCommand(`{"${key}":{}}`).ok).toBeFalse();
      expect(decodePolicyDefinitions(`{"${key}":{}}`).ok).toBeFalse();
    }
    expect(decodeWorkGraph(`\u00a0${validGraph}\u00a0`).ok).toBeFalse();
  });

  test("strict schemas reject empty canonical identifiers", () => {
    expect(
      decodeWorkGraph(
        JSON.stringify({
          ...graph(),
          nodes: [{ id: "", kind: "work_item", title: "One" }],
        }),
      ).ok,
    ).toBeFalse();
    expect(
      validateGraph(
        {
          ...graph(),
          nodes: [{ id: "", kind: "work_item", title: "One" }],
        },
        registry,
      ).accepted,
    ).toBeFalse();
    expect(
      decodeWorkGraph(
        JSON.stringify({
          ...graph(),
          events: [{ ...event(), id: "" }],
        }),
      ).ok,
    ).toBeFalse();
  });

  test("the parser accepts a shallow graph inside every frozen public bound", () => {
    const nodes = Array.from({ length: 75_000 }, (_, index) => ({
      id: `node:${index}`,
      kind: "work_item",
      title: "x",
    }));
    expect(decodeWorkGraph(JSON.stringify({ ...graph(), nodes })).ok).toBeTrue();
  });

  test("policy custody is immutable, authenticated, and collision-free", () => {
    const mutableRule = {
      priorState: null,
      requestedState: "active" as const,
      transitionKind: "advance" as const,
    };
    const definitions = [
      {
        id: "x\u0000y",
        version: "z",
        authority: "administrative_assertion" as const,
        evidenceCategory: "agent_assertion" as const,
        rules: [mutableRule],
      },
      {
        id: "x",
        version: "y\u0000z",
        authority: "administrative_assertion" as const,
        evidenceCategory: "agent_assertion" as const,
        rules: [
          {
            priorState: null,
            requestedState: "achieved" as const,
            transitionKind: "advance" as const,
          },
        ],
      },
    ];
    const resolved = resolvePolicyRegistry(definitions);
    expect(resolved.ok).toBeTrue();
    if (!resolved.ok) return;
    const scope = resolved.digestScope;
    Reflect.set(mutableRule, "requestedState", "achieved");
    expect(resolved.digestScope).toBe(scope);
    const attached = attachPolicyRegistryDigest(resolved, sha256Text);
    expect(Object.isFrozen(attached)).toBeTrue();
    expect(Object.isFrozen(attached.definitions[0]?.rules[0])).toBeTrue();
    expect(authenticatePolicyRegistry(attached, sha256Text)).toBeTrue();
    expect(() => attachPolicyRegistryDigest(resolved, () => "sha256:bad")).toThrow();
    const forged = {
      ...attached,
      digest: `sha256:${"0".repeat(64)}`,
    } as ResolvedPolicyRegistry;
    expect(authenticatePolicyRegistry(forged, sha256Text)).toBeFalse();
  });

  test("genesis bytes, complete document digest, and decode are deterministic", () => {
    const input = graph();
    const document = createGenesisDocument(input, sha256Text);
    Reflect.set(input.nodes[0]!, "title", "Changed after genesis");
    expect(document.graph.nodes[0]?.title).toBe("One");
    expect(Object.isFrozen(document.graph.nodes[0])).toBeTrue();
    const encoded = encodeLocalDocument(document);
    const decoded = decodeLocalDocument(encoded);
    expect(decoded.ok).toBeTrue();
    expect(documentDigest(document, sha256Text)).toBe(
      "sha256:8933c5555d6c2cede6923a1843f5f962622e63e6198d05883c28ca88d4d2da5d",
    );
    expect(validateDocumentCoherence(document, sha256Text).accepted).toBeTrue();
  });

  test("coherence validation stays within the public linear hash budget", () => {
    const events = Array.from({ length: 1_000 }, (_, index) => event(`event:${index}`));
    let calls = 0;
    const counted: HashFunction = (text) => {
      calls += 1;
      return sha256Text(text);
    };
    const document = createGenesisDocument(graph(events), counted);
    calls = 0;
    const result = validateDocumentCoherence(document, counted);
    expect(result.accepted).toBeTrue();
    expect(calls).toBeLessThanOrEqual(3_004);
  });

  test("pure append is digest-bound, idempotent, and preserves the prefix", () => {
    const document = createGenesisDocument(graph(), sha256Text);
    const identity = validateDocumentCoherence(document, sha256Text).identity!;
    const command: AppendTransitionCommand = {
      schemaVersion: "workgraph.command.append-transition/v1alpha1",
      idempotencyKey: "append-one",
      expectedRevision: 0,
      expectedGraphDigest: document.graphDigest,
      expectedPolicyRegistryDigest: registry.digest,
      event: event(),
    };
    const digest = commandDigest(command, sha256Text);
    const decision = decideAppend(document, identity, command, digest, registry, sha256Text);
    expect(tagOf(decision)).toBe("Apply");
    if (!("candidateGraph" in decision)) return;
    const completion = completeAppend(document, decision, sha256Text, registry);
    expect(completion.ok).toBeTrue();
    if (!completion.ok) return;
    const completed = completion.document;
    expect(completed.graph.events).toEqual([event()]);
    expect(completed.revision).toBe(1);
    expect(validateDocumentCoherence(completed, sha256Text).accepted).toBeTrue();

    const duplicateIdentity = validateDocumentCoherence(completed, sha256Text).identity!;
    expect(
      tagOf(decideAppend(completed, duplicateIdentity, command, digest, registry, sha256Text)),
    ).toBe("AlreadyApplied");
    expect(
      decideAppend(
        completed,
        duplicateIdentity,
        { ...command, event: event("event:other") },
        commandDigest({ ...command, event: event("event:other") }, sha256Text),
        registry,
        sha256Text,
      ),
    ).toMatchObject({ _tag: "Conflict", code: "idempotency_key_reused" });
  });

  test("decision rejects incoherent documents, forged identities, and forged completion plans", () => {
    const document = createGenesisDocument(graph(), sha256Text);
    const identity = validateDocumentCoherence(document, sha256Text).identity!;
    const command: AppendTransitionCommand = {
      schemaVersion: "workgraph.command.append-transition/v1alpha1",
      idempotencyKey: "custody",
      expectedRevision: 0,
      expectedGraphDigest: document.graphDigest,
      expectedPolicyRegistryDigest: registry.digest,
      event: event(),
    };
    const digest = commandDigest(command, sha256Text);
    const incoherent = { ...document, revision: 1 };
    expect(
      tagOf(
        decideAppend(
          incoherent,
          { ...identity, revision: 1 },
          command,
          digest,
          registry,
          sha256Text,
        ),
      ),
    ).toBe("Rejected");
    expect(
      tagOf(
        decideAppend(document, { ...identity, revision: 1 }, command, digest, registry, sha256Text),
      ),
    ).toBe("Rejected");

    const decision = decideAppend(document, identity, command, digest, registry, sha256Text);
    if (!("candidateGraph" in decision)) throw new Error("expected Apply");
    const forgedDecision = {
      ...decision,
      nextRevision: 2,
    };
    expect(completeAppend(document, forgedDecision, sha256Text, registry).ok).toBeFalse();
  });

  test("decision rejects a supplied digest that does not authenticate the command", () => {
    const document = createGenesisDocument(graph(), sha256Text);
    const identity = validateDocumentCoherence(document, sha256Text).identity!;
    const command: AppendTransitionCommand = {
      schemaVersion: "workgraph.command.append-transition/v1alpha1",
      idempotencyKey: "digest-custody",
      expectedRevision: 0,
      expectedGraphDigest: document.graphDigest,
      expectedPolicyRegistryDigest: registry.digest,
      event: event(),
    };
    const zeroDigest = `sha256:${"0".repeat(64)}` as Sha256Digest;
    const decision = decideAppend(document, identity, command, zeroDigest, registry, sha256Text);
    expect(decision).toMatchObject({
      _tag: "Rejected",
      issues: [{ code: "command_digest_authentication_failed" }],
    });
  });

  test("completion rejects a structurally valid plan that no decision authority issued", () => {
    const document = createGenesisDocument(graph(), sha256Text);
    const appendedEvent = event();
    const zeroDigest = `sha256:${"0".repeat(64)}` as Sha256Digest;
    const forgedDecision: Extract<AppendDecision, { readonly _tag: "Apply" }> = {
      _tag: "Apply",
      candidateGraph: graph([appendedEvent]),
      nextRevision: 1,
      receiptSeed: {
        idempotencyKey: "never-commanded",
        commandDigest: zeroDigest,
        policyRegistryDigest: registry.digest,
        eventId: appendedEvent.id,
        eventIndex: 0,
        priorEventChainDigest: document.eventChainDigest,
        priorRevision: 0,
        priorGraphDigest: document.graphDigest,
        resultRevision: 1,
      },
    };
    const completion = completeAppend(document, forgedDecision, sha256Text, registry);
    expect(completion).toMatchObject({
      ok: false,
      issues: [{ code: "append_plan_authentication_failed" }],
    });
  });

  test("completion binds an issued plan to the exact coherent input document", () => {
    const genesis = createGenesisDocument(graph(), sha256Text);
    const firstCommand: AppendTransitionCommand = {
      schemaVersion: "workgraph.command.append-transition/v1alpha1",
      idempotencyKey: "first",
      expectedRevision: 0,
      expectedGraphDigest: genesis.graphDigest,
      expectedPolicyRegistryDigest: registry.digest,
      event: event("event:first"),
    };
    const firstDecision = decideAppend(
      genesis,
      validateDocumentCoherence(genesis, sha256Text).identity!,
      firstCommand,
      commandDigest(firstCommand, sha256Text),
      registry,
      sha256Text,
    );
    if (!("candidateGraph" in firstDecision)) throw new Error("expected first Apply");
    const firstCompletion = completeAppend(genesis, firstDecision, sha256Text, registry);
    if (!firstCompletion.ok) throw new Error("expected first completion");
    const documentA = firstCompletion.document;
    const zeroDigest = `sha256:${"0".repeat(64)}` as Sha256Digest;
    const documentB = {
      ...documentA,
      receipts: [{ ...documentA.receipts[0]!, commandDigest: zeroDigest }],
    };
    const identityA = validateDocumentCoherence(documentA, sha256Text).identity!;
    const identityB = validateDocumentCoherence(documentB, sha256Text).identity!;
    expect(identityB).toBeDefined();
    expect(identityA.documentDigest).not.toBe(identityB.documentDigest);

    const secondEvent: TransitionEvent = {
      ...event("event:second"),
      priorState: "active",
      requestedState: "achieved",
    };
    const secondCommand: AppendTransitionCommand = {
      schemaVersion: "workgraph.command.append-transition/v1alpha1",
      idempotencyKey: "second",
      expectedRevision: documentA.revision,
      expectedGraphDigest: documentA.graphDigest,
      expectedPolicyRegistryDigest: registry.digest,
      event: secondEvent,
    };
    const secondDecision = decideAppend(
      documentA,
      identityA,
      secondCommand,
      commandDigest(secondCommand, sha256Text),
      registry,
      sha256Text,
    );
    if (!("candidateGraph" in secondDecision)) throw new Error("expected second Apply");
    expect(completeAppend(documentB, secondDecision, sha256Text, registry)).toMatchObject({
      ok: false,
      issues: [{ code: "append_plan_authentication_failed" }],
    });
  });

  test("decision snapshots command aliases and counts the new receipt in public bounds", () => {
    expect(
      withinPublicDocumentBounds({
        nodes: 98_000,
        edges: 0,
        events: 1_000,
        requests: 0,
        receipts: 1_000,
      }),
    ).toBeTrue();
    expect(
      withinPublicDocumentBounds({
        nodes: 98_001,
        edges: 0,
        events: 1_000,
        requests: 0,
        receipts: 1_000,
      }),
    ).toBeFalse();

    const document = createGenesisDocument(graph(), sha256Text);
    const identity = validateDocumentCoherence(document, sha256Text).identity!;
    const mutableEvent = structuredClone(event()) as TransitionEvent;
    const command: AppendTransitionCommand = {
      schemaVersion: "workgraph.command.append-transition/v1alpha1",
      idempotencyKey: "snapshot",
      expectedRevision: 0,
      expectedGraphDigest: document.graphDigest,
      expectedPolicyRegistryDigest: registry.digest,
      event: mutableEvent,
    };
    const decision = decideAppend(
      document,
      identity,
      command,
      commandDigest(command, sha256Text),
      registry,
      sha256Text,
    );
    if (!("candidateGraph" in decision)) throw new Error("expected Apply");
    Reflect.set(mutableEvent, "id", "changed");
    const basis = mutableEvent.basis[0]!;
    Reflect.set(basis, "digest", "b".repeat(64));
    expect(decision.candidateGraph.events[0]?.id).toBe("event:one");
    expect(Reflect.get(decision.candidateGraph.events[0]!.basis[0]!, "digest")).toBe(
      "a".repeat(64),
    );
    expect(Object.isFrozen(decision.candidateGraph.events[0]?.basis[0])).toBeTrue();
  });
});
