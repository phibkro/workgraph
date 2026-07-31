import { describe, expect, test } from "bun:test";
import {
  commandDigest,
  completeAppend,
  createGenesisDocument,
  decideAppend,
  documentDigest,
  type AppendTransitionCommand,
  type HashFunction,
  validateDocumentCoherence,
} from "../src/core/local-command.ts";
import type { TransitionEvent, WorkGraph } from "../src/core/model.ts";
import { attachPolicyRegistryDigest, resolvePolicyRegistry } from "../src/core/policy-registry.ts";
import {
  decodeAppendCommand,
  decodeLocalDocument,
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
const registry = attachPolicyRegistryDigest(
  resolution,
  sha256Text(resolution.digestScope).slice("sha256:".length),
);
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

  test("genesis bytes, complete document digest, and decode are deterministic", () => {
    const document = createGenesisDocument(graph(), sha256Text);
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
    const decision = decideAppend(document, identity, command, digest, registry);
    expect(tagOf(decision)).toBe("Apply");
    if (!("candidateGraph" in decision)) return;
    const completed = completeAppend(document, decision, sha256Text);
    expect(completed.graph.events).toEqual([event()]);
    expect(completed.revision).toBe(1);
    expect(validateDocumentCoherence(completed, sha256Text).accepted).toBeTrue();

    const duplicateIdentity = validateDocumentCoherence(completed, sha256Text).identity!;
    expect(tagOf(decideAppend(completed, duplicateIdentity, command, digest, registry))).toBe(
      "AlreadyApplied",
    );
    expect(
      decideAppend(
        completed,
        duplicateIdentity,
        { ...command, event: event("event:other") },
        sha256Text("other"),
        registry,
      ),
    ).toMatchObject({ _tag: "Conflict", code: "idempotency_key_reused" });
  });
});
