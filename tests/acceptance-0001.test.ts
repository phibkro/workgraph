import { describe, expect, test } from "bun:test";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import { deriveRoadmap } from "../src/core/derive.ts";
import { reduceLifecycle, validateGraph } from "../src/core/graph.ts";
import type { GitCommitReference, TransitionEvent, WorkGraph } from "../src/core/model.ts";
import { normalizeGraph } from "../src/core/normalize.ts";
import { projectAll } from "../src/core/projections.ts";
import { acceptanceEvidence } from "../src/acceptance/manifest.ts";
import { buildViews, JourneyFailure, runCli, webCryptoSha256 } from "../src/cli/journey.ts";
import { fixtureCommit, tracerFixture } from "../src/fixture/tracer-0001.ts";

const REFERENCE_KINDS = new Set([
  "git_commit",
  "artifact",
  "machine_check",
  "external_record",
  "human_approval",
  "graph_event",
]);

const clone = (graph: WorkGraph): WorkGraph => structuredClone(graph) as WorkGraph;

const withEvents = (
  graph: WorkGraph,
  map: (events: ReadonlyArray<TransitionEvent>) => ReadonlyArray<TransitionEvent>,
): WorkGraph => ({ ...graph, events: map(graph.events) });

const derivedValueOf = (graph: WorkGraph, subjectId: string): string | undefined =>
  deriveRoadmap(normalizeGraph(graph)).statuses.find((status) => status.subjectId === subjectId)
    ?.value;

const issueCodes = (graph: WorkGraph): ReadonlyArray<string> =>
  validateGraph(normalizeGraph(graph)).issues.map((issue) => issue.code);

const builtViews = await Effect.runPromise(buildViews.pipe(Effect.provide(webCryptoSha256)));

describe("acceptance for design spec 0001", () => {
  test("item 1: the fixture validates and every transition has a typed exact basis", () => {
    const result = validateGraph(normalizeGraph(tracerFixture));
    expect(result.accepted).toBeTrue();
    expect(result.issues).toEqual([]);
    for (const event of tracerFixture.events) {
      expect(event.basis.length).toBeGreaterThanOrEqual(1);
      for (const reference of event.basis) {
        expect(REFERENCE_KINDS.has(reference.kind)).toBeTrue();
      }
    }
  });

  test("item 2: weakening a commit object id invalidates the dependent transition", () => {
    const weakened = clone(tracerFixture);
    const probeEvent = weakened.events.find((event) => event.id === "event:exp-achieved")!;
    const check = probeEvent.basis[0];
    if (check.kind !== "machine_check") throw new Error("fixture changed");
    const subject = check.subjects[0] as { objectId: string };
    subject.objectId = subject.objectId.slice(0, 12);
    expect(issueCodes(weakened)).toContain("invalid_git_object_id");
    expect(validateGraph(normalizeGraph(weakened)).accepted).toBeFalse();
  });

  test("item 3: a branch name alone cannot satisfy an exact-subject requirement", () => {
    const branchRef: GitCommitReference = {
      ...fixtureCommit,
      objectId: "work/lag-probe-tracer",
    };
    const branchOnly = clone(tracerFixture);
    const probeEvent = branchOnly.events.find((event) => event.id === "event:exp-achieved")!;
    const check = probeEvent.basis[0];
    if (check.kind !== "machine_check") throw new Error("fixture changed");
    (check as { subjects: ReadonlyArray<GitCommitReference> }).subjects = [branchRef];
    expect(issueCodes(branchOnly)).toContain("invalid_git_object_id");
    // The full object id with a mutable branch as display context remains valid.
    expect(fixtureCommit.mutableContext).toBe("work/lag-probe-tracer");
    expect(validateGraph(normalizeGraph(tracerFixture)).accepted).toBeTrue();
  });

  test("item 4: a check bound to commit A cannot unlock the artifact from commit B", () => {
    const swapped = clone(tracerFixture);
    const expNode = swapped.nodes.find((node) => node.id === "exp:lag-probe")!;
    (expNode as { exactSubject: GitCommitReference }).exactSubject = {
      ...fixtureCommit,
      objectId: "b".repeat(40),
    };
    expect(issueCodes(swapped)).toContain("exact_subject_mismatch");
  });

  test("item 5: a human-approved transition stays a human-approved assertion in every view", () => {
    const explanationFile = builtViews.files.find(
      (file) => file.path === "transition-explanations.json",
    )!;
    const explanation = JSON.parse(explanationFile.content) as {
      events: ReadonlyArray<{
        id: string;
        authority: string;
        evidenceCategory: string;
        machineChecked: boolean;
        humanApprovedAssertion: boolean;
      }>;
    };
    const humanEvents = explanation.events.filter((event) => event.authority === "human_approval");
    expect(humanEvents.length).toBeGreaterThanOrEqual(1);
    for (const event of humanEvents) {
      expect(event.evidenceCategory).toBe("human_approved_assertion");
      expect(event.machineChecked).toBeFalse();
      expect(event.humanApprovedAssertion).toBeTrue();
    }
    const milestone = builtViews.files.find((file) => file.path === "milestone-status.md")!;
    expect(milestone.content).toContain("human-approved assertion; machine_checked: false");
    const mermaid = builtViews.files.find((file) => file.path === "capability-roadmap.mmd")!;
    expect(mermaid.content).toContain("human-approved assertion, machine_checked: false");
  });

  test("item 6: an agent's untyped done assertion cannot satisfy a machine-check gate", () => {
    const asserted = withEvents(clone(tracerFixture), (events) =>
      events.map((event) =>
        event.id === "event:exp-achieved"
          ? {
              ...event,
              evidenceCategory: "agent_assertion" as const,
              basis: [
                {
                  kind: "artifact" as const,
                  algorithm: "sha256" as const,
                  digest: "9c".repeat(32),
                  mediaType: "text/plain",
                },
              ] as const,
            }
          : event,
      ),
    );
    const codes = issueCodes(asserted);
    expect(codes).toContain("machine_policy_without_check");
  });

  test("item 7: a commit-declared request changes no state until an observer event references the resulting commit", () => {
    // The pending fixture request has no canonical effect.
    expect(reduceLifecycle(normalizeGraph(tracerFixture)).get("exp:replay-harness")).toBe("locked");
    expect(derivedValueOf(tracerFixture, "exp:replay-harness")).toBe("blocked");

    const observerEvent: TransitionEvent = {
      id: "event:replay-activated",
      subjectId: "exp:replay-harness",
      priorState: null,
      requestedState: "active",
      transitionKind: "advance",
      actor: "adapter:git-observer",
      authority: "imported_observation",
      evidenceCategory: "external_observation",
      basis: [{ ...fixtureCommit, objectId: "c".repeat(40) }],
      policy: "workgraph.policy.imported-observation",
      policyVersion: "1",
      rationale: "An observer saw the immutable commit that carried the declared request.",
      observedAt: "2026-07-30T03:00:00Z",
      fulfillsRequest: "request:activate-replay",
    };

    const withoutCommit = withEvents(clone(tracerFixture), (events) => [
      ...events,
      {
        ...observerEvent,
        basis: [
          {
            kind: "external_record",
            provider: "fictional-terminal-multiplexer",
            project: "orchard",
            recordId: "session/amber-8",
            observedAt: "2026-07-30T03:00:00Z",
            interpretation: "A provider record alone, without the immutable commit.",
          },
        ],
      },
    ]);
    expect(issueCodes(withoutCommit)).toContain("request_fulfillment_without_commit");

    const fulfilled = withEvents(clone(tracerFixture), (events) => [...events, observerEvent]);
    expect(validateGraph(normalizeGraph(fulfilled)).accepted).toBeTrue();
    expect(reduceLifecycle(normalizeGraph(fulfilled)).get("exp:replay-harness")).toBe("active");
  });

  test("item 8: correcting a transition supersedes and preserves the prior event", () => {
    const correction: TransitionEvent = {
      id: "event:report-correction",
      subjectId: "artifact:probe-report",
      priorState: "achieved",
      requestedState: "stale",
      transitionKind: "correct",
      actor: "operator:frost",
      authority: "administrative_assertion",
      evidenceCategory: "agent_assertion",
      basis: [
        { kind: "graph_event", eventId: "event:report-registered" },
        {
          kind: "artifact",
          algorithm: "sha256",
          digest: "6f".repeat(32),
          mediaType: "application/json",
        },
      ],
      policy: "workgraph.policy.administrative",
      policyVersion: "1",
      rationale: "The registered report was corrected; the prior event stays in history.",
      observedAt: "2026-07-30T04:00:00Z",
      supersedes: "event:report-registered",
    };
    const corrected = withEvents(clone(tracerFixture), (events) => [...events, correction]);
    const normalized = normalizeGraph(corrected);
    expect(validateGraph(normalized).accepted).toBeTrue();
    expect(normalized.events.map((event) => event.id)).toContain("event:report-registered");
    expect(reduceLifecycle(normalized).get("artifact:probe-report")).toBe("stale");

    const unreferenced = withEvents(clone(tracerFixture), (events) => [
      ...events,
      { ...correction, basis: [correction.basis[1]!, correction.basis[1]!] as never },
    ]);
    expect(issueCodes(unreferenced)).toContain("supersession_without_event_basis");
  });

  test("item 9: the canonical graph accepts the fixture's legal feedback cycle", () => {
    const cycleEdges = tracerFixture.edges.filter(
      (edge) => edge.id === "edge:rq-supports-design" || edge.id === "edge:design-from-rq",
    );
    expect(cycleEdges).toHaveLength(2);
    expect(new Set(cycleEdges.map((edge) => edge.kind))).toEqual(
      new Set(["supports", "derived_from"]),
    );
    expect(validateGraph(normalizeGraph(tracerFixture)).accepted).toBeTrue();
  });

  test("item 10: a requires or contains cycle fails the applicable projection", () => {
    const requiresCycle: WorkGraph = {
      ...clone(tracerFixture),
      edges: [
        ...tracerFixture.edges,
        {
          id: "edge:cycle-back",
          kind: "requires",
          from: "design:lag-probe",
          to: "cap:multi-region",
        },
        {
          id: "edge:cycle-forward",
          kind: "requires",
          from: "cap:multi-region",
          to: "design:lag-probe",
        },
      ],
    };
    expect(issueCodes(requiresCycle)).toContain("requires_cycle");
    const outcome = projectAll(
      normalizeGraph(requiresCycle),
      deriveRoadmap(normalizeGraph(requiresCycle)),
      "0".repeat(64),
    );
    expect(outcome.ok).toBeFalse();
    if (!outcome.ok) expect(outcome.failure.detail).toContain("requires_cycle");

    const containsCycle: WorkGraph = {
      ...clone(tracerFixture),
      edges: [
        ...tracerFixture.edges,
        { id: "edge:contains-back", kind: "contains", from: "ms:0001", to: "project:orchard" },
      ],
    };
    expect(issueCodes(containsCycle)).toContain("contains_cycle");
    expect(
      projectAll(
        normalizeGraph(containsCycle),
        deriveRoadmap(normalizeGraph(containsCycle)),
        "0".repeat(64),
      ).ok,
    ).toBeFalse();
  });

  test("item 11: the roadmap derives all required values with source-level explanations", () => {
    const derivation = deriveRoadmap(normalizeGraph(tracerFixture));
    const byValue = new Map<string, string>();
    for (const status of derivation.statuses) byValue.set(status.value, status.subjectId);
    for (const value of ["locked", "available", "active", "achieved", "stale", "blocked"]) {
      expect(byValue.has(value)).toBeTrue();
    }
    for (const status of derivation.statuses) {
      expect(status.rulesFired.length).toBeGreaterThanOrEqual(1);
      expect(status.policy).toBe("workgraph.policy.roadmap-derivation");
      expect(
        status.sourceNodes.length + status.sourceEdges.length + status.sourceEvents.length,
      ).toBeGreaterThanOrEqual(1);
    }
    const locked = derivation.statuses.find((status) => status.value === "locked")!;
    expect(locked.unsatisfiedPrerequisites.length).toBeGreaterThanOrEqual(1);
  });

  test("item 12: AND and OR prerequisites unlock exactly the intended paths", () => {
    // Fixture baseline: AND gate satisfied, OR satisfied through one path.
    expect(derivedValueOf(tracerFixture, "cap:lag-attribution")).toBe("available");
    expect(derivedValueOf(tracerFixture, "cap:replay-validation")).toBe("available");
    expect(derivedValueOf(tracerFixture, "cap:multi-region")).toBe("locked");

    // Dropping one AND prerequisite locks the AND-gated capability only.
    const withoutGate = withEvents(clone(tracerFixture), (events) =>
      events.filter((event) => event.id !== "event:gate-achieved"),
    );
    expect(derivedValueOf(withoutGate, "cap:lag-attribution")).toBe("locked");
    expect(derivedValueOf(withoutGate, "cap:replay-validation")).toBe("available");

    // Dropping the achieved OR path locks the OR capability; the alternative
    // path unlocks it again.
    const withoutProbe = withEvents(clone(tracerFixture), (events) =>
      events.filter(
        (event) => event.id !== "event:exp-achieved" && event.id !== "event:gate-achieved",
      ),
    );
    expect(derivedValueOf(withoutProbe, "cap:replay-validation")).toBe("locked");

    const alternativePath = withEvents(withoutProbe, (events) => [
      ...events,
      {
        id: "event:replay-achieved",
        subjectId: "exp:replay-harness",
        priorState: null,
        requestedState: "achieved" as const,
        transitionKind: "advance" as const,
        actor: "workgraph.policy.machine-check/v1",
        authority: "machine_policy" as const,
        evidenceCategory: "machine_check" as const,
        basis: [
          {
            kind: "machine_check" as const,
            checker: "replay-harness-check",
            checkerVersion: "1.0.0",
            subjects: [{ ...fixtureCommit, objectId: "d".repeat(40) }],
            policy: "orchard.policy.replay/v1",
            operation: "replay --full",
            environment: "fixture-runner/linux-x64",
            result: "passed" as const,
            exitCode: 0,
            output: {
              kind: "artifact" as const,
              algorithm: "sha256" as const,
              digest: "ab".repeat(32),
              mediaType: "text/plain",
            },
            observedAt: "2026-07-30T05:00:00Z",
          },
        ] as const,
        policy: "workgraph.policy.machine-check",
        policyVersion: "1",
        rationale: "The alternative realization path passed its bound check.",
        observedAt: "2026-07-30T05:00:05Z",
      },
    ]);
    expect(derivedValueOf(alternativePath, "cap:replay-validation")).toBe("available");
    expect(derivedValueOf(alternativePath, "cap:lag-attribution")).toBe("locked");
  });

  test("item 13: every projection carries the same canonical digest", () => {
    const digestLine = `sha256:${builtViews.canonicalDigest}`;
    for (const file of builtViews.files) {
      if (file.path === "normalized-graph.json") continue;
      expect(file.content).toContain(digestLine);
    }
    const manifest = JSON.parse(
      builtViews.files.find((file) => file.path === "drift-manifest.json")!.content,
    ) as { canonicalDigest: string; files: ReadonlyArray<{ path: string; sha256: string }> };
    expect(manifest.canonicalDigest).toBe(digestLine);
    expect(manifest.files.map((file) => file.path).toSorted()).toEqual(
      builtViews.files
        .map((file) => file.path)
        .filter((path) => path !== "drift-manifest.json")
        .toSorted(),
    );
  });

  test("item 14: editing a generated projection makes the drift check fail", async () => {
    const dir = `${import.meta.dir}/../.tmp-drift-check`;
    const layers = Layer.mergeAll(BunFileSystem.layer, webCryptoSha256);
    const generate = runCli(["generate", "--out", dir]).pipe(Effect.provide(layers));
    const check = runCli(["check", "--out", dir]).pipe(Effect.provide(layers));
    try {
      await Effect.runPromise(generate);
      await Effect.runPromise(check);

      const target = `${dir}/capability-roadmap.json`;
      const original = await Bun.file(target).text();
      await Bun.write(target, original.replace("available", "achieved"));
      await expect(Effect.runPromise(check)).rejects.toThrow(/generated_view_drift/u);

      await Bun.write(target, original);
      await Effect.runPromise(check);
      await Bun.write(`${dir}/rogue-view.json`, "{}\n");
      await expect(Effect.runPromise(check)).rejects.toThrow(/generated_view_drift/u);
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });

  test("item 17: no unsupported claim vocabulary appears in any projection", () => {
    const forbidden = [
      "formally proven",
      "proven correct",
      "guaranteed",
      "tamper-proof",
      "operationally suitable",
      "cryptographically verified",
    ];
    for (const file of builtViews.files) {
      const lowered = file.content.toLowerCase();
      for (const phrase of forbidden) {
        expect(lowered.includes(phrase)).toBeFalse();
      }
    }
  });

  test("the evidence manifest covers items 1 through 17 exactly once", () => {
    expect(acceptanceEvidence.map((entry) => entry.item)).toEqual(
      Array.from({ length: 17 }, (_, index) => index + 1),
    );
    for (const entry of acceptanceEvidence) {
      expect(entry.establishedBy.length).toBeGreaterThanOrEqual(1);
      expect(entry.evidenceCategory).toBe("machine_check");
    }
  });

  test("journey failures carry typed codes", () => {
    const failure = new JourneyFailure("usage", ["expected: generate|check"]);
    expect(failure.code).toBe("usage");
    expect(String(failure)).toContain("usage");
  });
});
