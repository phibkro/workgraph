import { describe, expect, test } from "bun:test";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import { deriveRoadmap } from "../src/core/derive.ts";
import { effectiveEvents, reduceLifecycle, validateGraph } from "../src/core/graph.ts";
import type { GitCommitReference, TransitionEvent, WorkGraph } from "../src/core/model.ts";
import { normalizeGraph } from "../src/core/normalize.ts";
import { projectAll } from "../src/core/projections.ts";
import { validateBasisReference } from "../src/core/references.ts";
import { portableImportViolations } from "../scripts/portable-import-policy.ts";
import { unsupportedClaimFindings } from "../src/acceptance/claims.ts";
import { acceptanceCoverage } from "../src/acceptance/manifest.ts";
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
        expect(validateBasisReference(reference)).toEqual([]);
      }
    }

    const emptyBasis = clone(tracerFixture);
    const event = emptyBasis.events.find((candidate) => candidate.id === "event:rq-active")!;
    (event as unknown as { basis: ReadonlyArray<never> }).basis = [];
    expect(issueCodes(emptyBasis)).toContain("empty_transition_basis");
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
    const commitB: GitCommitReference = { ...fixtureCommit, objectId: "b".repeat(40) };
    (expNode as { exactSubject: GitCommitReference }).exactSubject = commitB;
    expect(issueCodes(swapped)).toContain("exact_subject_mismatch");

    // Basis padding: a passing check for commit A plus a bare reference to
    // commit B must not unlock a node whose exact subject is commit B. The
    // bare reference satisfies the generic subject match, so only conjoint
    // validation (the passing check itself naming the subject) rejects it.
    const padded = clone(tracerFixture);
    const paddedNode = padded.nodes.find((node) => node.id === "exp:lag-probe")!;
    (paddedNode as { exactSubject: GitCommitReference }).exactSubject = commitB;
    const paddedEvent = padded.events.find((event) => event.id === "event:exp-achieved")!;
    (paddedEvent as { basis: unknown }).basis = [paddedEvent.basis[0], commitB];
    const codes = issueCodes(padded);
    expect(codes).toContain("machine_check_not_bound_and_passing");
    expect(validateGraph(normalizeGraph(padded)).accepted).toBeFalse();

    // The same conjoint rule applies to human approvals: an approval about a
    // different artifact cannot advance a node even when the node's exact
    // reference is padded into the basis alongside it.
    const paddedApproval = clone(tracerFixture);
    const designNode = paddedApproval.nodes.find((node) => node.id === "design:lag-probe")!;
    const otherArtifact = {
      kind: "artifact" as const,
      algorithm: "sha256" as const,
      digest: "cd".repeat(32),
      mediaType: "text/markdown",
    };
    (designNode as { exactSubject: unknown }).exactSubject = otherArtifact;
    const approvalEvent = paddedApproval.events.find(
      (event) => event.id === "event:design-achieved",
    )!;
    (approvalEvent as { basis: unknown }).basis = [approvalEvent.basis[0], otherArtifact];
    expect(issueCodes(paddedApproval)).toContain("human_approval_not_bound");
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
        policyRulesFired: ReadonlyArray<string>;
      }>;
    };
    for (const event of explanation.events) {
      expect(event.policyRulesFired.length).toBeGreaterThanOrEqual(2);
    }
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
    (observerEvent as { basis: unknown }).basis = [
      observerEvent.basis[0],
      {
        kind: "external_record",
        provider: "fixture-git-observer",
        project: "orchard",
        recordId: "request:activate-replay",
        observedVersion: "c".repeat(40),
        observedAt: "2026-07-30T03:00:00Z",
        interpretation: "The observer reports the immutable resulting commit carrying the request.",
      },
    ];

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
      priorState: null,
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
    expect(issueCodes(unreferenced)).toContain("correction_event_basis_mismatch");

    // Correcting a NON-latest event must not overwrite later uncorrected
    // state: the correction replays at the corrected event's historical
    // position. rq:lag-attribution went active (event:rq-active) then
    // achieved (event:rq-achieved); correcting the activation must leave the
    // later achievement in force.
    const earlyCorrection: TransitionEvent = {
      id: "event:rq-active-corrected",
      subjectId: "rq:lag-attribution",
      priorState: null,
      requestedState: "active",
      transitionKind: "correct",
      actor: "operator:frost",
      authority: "administrative_assertion",
      evidenceCategory: "agent_assertion",
      basis: [
        { kind: "graph_event", eventId: "event:rq-active" },
        {
          kind: "artifact",
          algorithm: "sha256",
          digest: "2b".repeat(32),
          mediaType: "text/markdown",
        },
      ],
      policy: "workgraph.policy.administrative",
      policyVersion: "1",
      rationale: "The activation record named the wrong actor; the activation itself stands.",
      observedAt: "2026-07-30T06:00:00Z",
      supersedes: "event:rq-active",
    };
    const earlyCorrected = withEvents(clone(tracerFixture), (events) => [
      ...events,
      earlyCorrection,
    ]);
    const earlyNormalized = normalizeGraph(earlyCorrected);
    expect(validateGraph(earlyNormalized).accepted).toBeTrue();
    expect(reduceLifecycle(earlyNormalized).get("rq:lag-attribution")).toBe("achieved");
    expect(derivedValueOf(earlyCorrected, "rq:lag-attribution")).toBe("achieved");

    // Milestone projection consumes the effective replay, not the last raw
    // appended correction. Correcting the earlier activation as an
    // administrative assertion must not relabel the later achieved machine
    // event.
    const expActivationCorrection: TransitionEvent = {
      id: "event:exp-active-corrected",
      subjectId: "exp:lag-probe",
      priorState: null,
      requestedState: "active",
      transitionKind: "correct",
      actor: "operator:frost",
      authority: "administrative_assertion",
      evidenceCategory: "agent_assertion",
      basis: [{ kind: "graph_event", eventId: "event:exp-active" }, fixtureCommit],
      policy: "workgraph.policy.administrative",
      policyVersion: "1",
      rationale: "Correct the activation actor while preserving its state.",
      observedAt: "2026-07-30T08:00:00Z",
      supersedes: "event:exp-active",
    };
    const projectedCorrection = normalizeGraph(
      withEvents(clone(tracerFixture), (events) => [...events, expActivationCorrection]),
    );
    const projectedOutcome = projectAll(
      projectedCorrection,
      deriveRoadmap(projectedCorrection),
      "0".repeat(64),
    );
    expect(projectedOutcome.ok).toBeTrue();
    if (projectedOutcome.ok) {
      const milestone = projectedOutcome.files.find((file) => file.path === "milestone-status.md")!;
      expect(milestone.content).toContain(
        "| Lag-probe tracer experiment | work_item | achieved | machine_check | machine-checked against its exact subject |",
      );
    }
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

  test("item 12: AND, OR, and optional prerequisites unlock exactly the intended paths", () => {
    // Fixture baseline: AND gate satisfied, OR satisfied through one path.
    expect(derivedValueOf(tracerFixture, "cap:lag-attribution")).toBe("available");
    expect(derivedValueOf(tracerFixture, "cap:replay-validation")).toBe("available");
    expect(derivedValueOf(tracerFixture, "cap:multi-region")).toBe("locked");
    const fixtureReport = deriveRoadmap(normalizeGraph(tracerFixture)).prerequisites.find(
      (report) => report.subjectId === "cap:lag-attribution",
    )!;
    expect(fixtureReport.optionalPrerequisites).toEqual([
      {
        targetId: "exp:replay-harness",
        edgeId: "edge:cap-lag-optional-replay",
        satisfied: false,
      },
    ]);
    expect(fixtureReport.satisfied).toBeTrue();

    // The same unsatisfied edge becomes a real AND prerequisite when the
    // explicit optional marker is removed.
    const requiredReplay = clone(tracerFixture);
    const optionalEdge = requiredReplay.edges.find(
      (edge) => edge.id === "edge:cap-lag-optional-replay",
    )!;
    (optionalEdge as { attributes?: Readonly<Record<string, unknown>> }).attributes = {};
    expect(derivedValueOf(requiredReplay, "cap:lag-attribution")).toBe("locked");

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

    // The alternative path is realized at its own exact commit; the node
    // declares it so the machine check can bind conjointly.
    const replayCommit: GitCommitReference = { ...fixtureCommit, objectId: "d".repeat(40) };
    const withBoundReplay: WorkGraph = {
      ...withoutProbe,
      nodes: withoutProbe.nodes.map((node) =>
        node.id === "exp:replay-harness"
          ? Object.assign(structuredClone(node), { exactSubject: replayCommit })
          : node,
      ),
    };
    const alternativePath = withEvents(withBoundReplay, (events) => [
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
        policy: "orchard.policy.replay",
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
      expect(file.content).toContain(digestLine);
    }
    const normalizedProjection = JSON.parse(
      builtViews.files.find((file) => file.path === "normalized-graph.json")!.content,
    ) as { canonicalDigest: string; digestScope: string; canonicalGraph: WorkGraph };
    expect(normalizedProjection.canonicalDigest).toBe(digestLine);
    expect(normalizedProjection.digestScope).toContain("not a hash of this wrapper");
    expect(normalizedProjection.canonicalGraph).toEqual(normalizeGraph(tracerFixture));
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
    for (const file of builtViews.files) {
      expect({ path: file.path, findings: unsupportedClaimFindings(file.content) }).toEqual({
        path: file.path,
        findings: [],
      });
    }
  });

  test("item 17: the shared claim vocabulary catches variations, not only exact phrases", () => {
    const caught = [
      "This result is Proven.",
      "provably correct output",
      "the pipeline is formally verified",
      "delivery is guaranteed",
      "a tamper proof ledger",
      "judged production-ready",
      "operationally suitable for use",
      "the actor was authenticated",
      "certified by the runner",
      "independently verified results",
    ];
    for (const claim of caught) {
      expect({ claim, findings: unsupportedClaimFindings(claim) }).not.toEqual({
        claim,
        findings: [],
      });
    }
    const allowed = [
      "authentication: unverified",
      "human_approved_assertion with machine_checked: false",
      "maturity: independently_reviewed",
      "the provider_authenticated flag was not set",
    ];
    for (const text of allowed) {
      expect({ text, findings: unsupportedClaimFindings(text) }).toEqual({ text, findings: [] });
    }
  });

  test("blocks resolve from the blocker's lifecycle: abandoned blockers stop blocking", () => {
    // Baseline: the achieved-but-contradicted assumption still blocks.
    expect(derivedValueOf(tracerFixture, "exp:replay-harness")).toBe("blocked");

    const abandoned = withEvents(clone(tracerFixture), (events) => [
      ...events,
      {
        id: "event:risk-abandoned",
        subjectId: "risk:steady-clock",
        priorState: "achieved",
        requestedState: "abandoned" as const,
        transitionKind: "advance" as const,
        actor: "operator:frost",
        authority: "administrative_assertion" as const,
        evidenceCategory: "agent_assertion" as const,
        basis: [
          {
            kind: "artifact" as const,
            algorithm: "sha256" as const,
            digest: "5e".repeat(32),
            mediaType: "text/markdown",
          },
        ] as const,
        policy: "workgraph.policy.administrative",
        policyVersion: "1",
        rationale: "The steady-clock assumption is withdrawn after the skew incident.",
        observedAt: "2026-07-30T07:00:00Z",
      },
    ]);
    expect(derivedValueOf(abandoned, "risk:steady-clock")).toBe("stale");
    expect(derivedValueOf(abandoned, "exp:replay-harness")).not.toBe("blocked");
  });

  test("blocked and stale explanations carry blocker, assumption, and contradiction events", () => {
    const derivation = deriveRoadmap(normalizeGraph(tracerFixture));
    const blocked = derivation.statuses.find(
      (status) => status.subjectId === "exp:replay-harness",
    )!;
    expect(blocked.value).toBe("blocked");
    expect(blocked.sourceEvents).toContain("event:risk-assumed");
    expect(blocked.sourceEvents).toContain("event:clock-skew-observed");
    expect(blocked.sourceEdges).toContain("edge:assumption-blocks-replay");
    expect(blocked.sourceEdges).toContain("edge:incident-contradicts-assumption");

    const stale = derivation.statuses.find((status) => status.subjectId === "risk:steady-clock")!;
    expect(stale.value).toBe("stale");
    expect(stale.sourceEvents).toContain("event:risk-assumed");
    expect(stale.sourceEvents).toContain("event:clock-skew-observed");
  });

  test("typed evidence roles, not free-form attributes, derive maturity rungs", () => {
    const freeForm = clone(tracerFixture);
    const incident = freeForm.nodes.find((node) => node.id === "ev:clock-skew-incident")!;
    (incident as unknown as { evidenceRole?: undefined }).evidenceRole = undefined;
    (incident as { attributes?: Readonly<Record<string, string>> }).attributes = {
      category: "operational_observation",
    };
    (freeForm as unknown as { edges: WorkGraph["edges"] }).edges = [
      ...freeForm.edges,
      {
        id: "edge:incident-supports-capability",
        kind: "supports",
        from: "ev:clock-skew-incident",
        to: "cap:lag-attribution",
      },
    ];
    const freeMaturity = deriveRoadmap(normalizeGraph(freeForm)).capabilities.find(
      (entry) => entry.capabilityId === "cap:lag-attribution",
    )!;
    expect(freeMaturity.satisfiedRungs.map((entry) => entry.rung)).not.toContain(
      "operationally_observed",
    );

    (incident as { evidenceRole?: string }).evidenceRole = "operational_observation";
    const typedMaturity = deriveRoadmap(normalizeGraph(freeForm)).capabilities.find(
      (entry) => entry.capabilityId === "cap:lag-attribution",
    )!;
    expect(typedMaturity.satisfiedRungs.map((entry) => entry.rung)).toContain(
      "operationally_observed",
    );
  });

  test("append order, not observation timestamps, determines lifecycle replay", () => {
    const appended: TransitionEvent = {
      id: "event:risk-withdrawn-with-earlier-observation",
      subjectId: "risk:steady-clock",
      priorState: "achieved",
      requestedState: "abandoned",
      transitionKind: "advance",
      actor: "operator:frost",
      authority: "administrative_assertion",
      evidenceCategory: "agent_assertion",
      basis: [
        {
          kind: "artifact",
          algorithm: "sha256",
          digest: "5e".repeat(32),
          mediaType: "text/markdown",
        },
      ],
      policy: "workgraph.policy.administrative",
      policyVersion: "1",
      rationale: "Late append records a withdrawal observed by an earlier clock.",
      observedAt: "2020-01-01T00:00:00Z",
    };
    const graph = normalizeGraph(
      withEvents(clone(tracerFixture), (events) => [...events, appended]),
    );
    expect(graph.events.at(-1)?.id).toBe(appended.id);
    expect(validateGraph(graph).accepted).toBeTrue();
    expect(reduceLifecycle(graph).get("risk:steady-clock")).toBe("abandoned");
  });

  test("authority categories cannot be laundered and named policies are closed", () => {
    const laundered = clone(tracerFixture);
    const report = laundered.events.find((event) => event.id === "event:report-registered")!;
    (report as { evidenceCategory: string }).evidenceCategory = "machine_check";
    expect(issueCodes(laundered)).toContain("policy_evidence_category_mismatch");

    const importedLaundering = clone(tracerFixture);
    const session = importedLaundering.events.find((event) => event.id === "event:session-active")!;
    (session as { evidenceCategory: string }).evidenceCategory = "human_approved_assertion";
    expect(issueCodes(importedLaundering)).toContain("policy_evidence_category_mismatch");

    const unknownPolicy = clone(tracerFixture);
    const gate = unknownPolicy.events.find((event) => event.id === "event:gate-achieved")!;
    (gate as { policy: string }).policy = "attacker.policy.accept-anything";
    expect(issueCodes(unknownPolicy)).toContain("unknown_transition_policy");

    const mismatchedContract = clone(tracerFixture);
    const probe = mismatchedContract.events.find((event) => event.id === "event:exp-achieved")!;
    const check = probe.basis.find((reference) => reference.kind === "machine_check")!;
    (check as { policy: string }).policy = "orchard.policy.gate-0001/v1";
    expect(issueCodes(mismatchedContract)).toContain("machine_check_policy_mismatch");

    const forbiddenEdge = clone(tracerFixture);
    const forbiddenGate = forbiddenEdge.events.find((event) => event.id === "event:gate-achieved")!;
    (forbiddenGate as { requestedState: string }).requestedState = "active";
    expect(issueCodes(forbiddenEdge)).toContain("transition_edge_not_allowed");
  });

  test("all frozen reference families reject non-exact identities", () => {
    const external = clone(tracerFixture);
    const clock = external.events.find((event) => event.id === "event:clock-skew-observed")!;
    const externalRecord = clock.basis.find((reference) => reference.kind === "external_record")!;
    delete (externalRecord as { observedVersion?: string }).observedVersion;
    expect(issueCodes(external)).toContain("missing_immutable_external_revision");

    const machine = clone(tracerFixture);
    const machineEvent = machine.events.find((event) => event.id === "event:exp-achieved")!;
    const machineCheck = machineEvent.basis.find(
      (reference) => reference.kind === "machine_check",
    )!;
    (machineCheck.subjects[0] as { objectId: string }).objectId = "not-exact";
    expect(issueCodes(machine)).toContain("invalid_git_object_id");

    const approval = clone(tracerFixture);
    const approvalEvent = approval.events.find((event) => event.id === "event:design-achieved")!;
    const approvalReference = approvalEvent.basis.find(
      (reference) => reference.kind === "human_approval",
    )!;
    (approvalReference.subjects[0] as { digest: string }).digest = "short";
    expect(issueCodes(approval)).toContain("invalid_artifact_digest");

    expect(validateBasisReference(fixtureCommit)).toEqual([]);
    expect(
      validateBasisReference({
        kind: "graph_event",
        eventId: "",
      }),
    ).toContain("empty_graph_event_id");
  });

  test("corrections reject missing, unrelated, unknown, self, and competing custody", () => {
    const baseCorrection: TransitionEvent = {
      id: "event:report-correction-a",
      subjectId: "artifact:probe-report",
      priorState: null,
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
      rationale: "Correct the report registration.",
      observedAt: "2026-07-30T09:00:00Z",
      supersedes: "event:report-registered",
    };

    const missing = withEvents(clone(tracerFixture), (events) => [
      ...events,
      { ...baseCorrection, supersedes: undefined } as unknown as TransitionEvent,
    ]);
    expect(issueCodes(missing)).toContain("correction_supersession_mismatch");

    const unrelated = withEvents(clone(tracerFixture), (events) => [
      ...events,
      {
        ...baseCorrection,
        basis: [{ kind: "graph_event", eventId: "event:rq-active" }, baseCorrection.basis[1]!],
      },
    ]);
    expect(issueCodes(unrelated)).toContain("correction_event_basis_mismatch");

    const unknown = withEvents(clone(tracerFixture), (events) => [
      ...events,
      {
        ...baseCorrection,
        supersedes: "event:unknown",
        basis: [{ kind: "graph_event", eventId: "event:unknown" }, baseCorrection.basis[1]!],
      },
    ]);
    expect(issueCodes(unknown)).toContain("invalid_supersession");

    const self = withEvents(clone(tracerFixture), (events) => [
      ...events,
      {
        ...baseCorrection,
        supersedes: baseCorrection.id,
        basis: [{ kind: "graph_event", eventId: baseCorrection.id }, baseCorrection.basis[1]!],
      },
    ]);
    expect(issueCodes(self)).toContain("invalid_supersession");
    expect(issueCodes(self)).toContain("correction_cycle");

    const competitor: TransitionEvent = {
      ...baseCorrection,
      id: "event:report-correction-b",
      requestedState: "achieved",
      observedAt: "2026-07-30T09:01:00Z",
    };
    const competing = withEvents(clone(tracerFixture), (events) => [
      ...events,
      baseCorrection,
      competitor,
    ]);
    expect(issueCodes(competing)).toContain("competing_corrections");

    const chain: TransitionEvent = {
      ...competitor,
      supersedes: baseCorrection.id,
      basis: [{ kind: "graph_event", eventId: baseCorrection.id }, baseCorrection.basis[1]!],
    };
    const chained = normalizeGraph(
      withEvents(clone(tracerFixture), (events) => [...events, baseCorrection, chain]),
    );
    expect(validateGraph(chained).accepted).toBeTrue();
    expect(
      effectiveEvents(chained).find((event) => event.subjectId === "artifact:probe-report")?.id,
    ).toBe(chain.id);
  });

  test("the portable-core import gate is an allowlist, not a denylist", () => {
    const violating = [
      "fs",
      "child_process",
      "http",
      "node:fs",
      "bun:test",
      "effect",
      "@effect/platform-bun",
      "left-pad",
      "../fixture/tracer-0001.ts",
      "../../scripts/check.ts",
    ];
    for (const specifier of violating) {
      expect(portableImportViolations("src/core/graph.ts", [specifier])).not.toEqual([]);
    }
    expect(
      portableImportViolations("src/core/graph.ts", ["./model.ts", "./references.ts"]),
    ).toEqual([]);
    expect(portableImportViolations("src/core/nested/deep.ts", ["../model.ts"])).toEqual([]);
  });

  test("the coverage manifest maps items 1 through 17 exactly once without claiming a run", () => {
    expect(acceptanceCoverage.map((entry) => entry.item)).toEqual(
      Array.from({ length: 17 }, (_, index) => index + 1),
    );
    for (const entry of acceptanceCoverage) {
      expect(entry.exercisedBy.length).toBeGreaterThanOrEqual(1);
      expect(entry).not.toHaveProperty("evidenceCategory");
    }
    const generated = builtViews.files.find(
      (file) => file.path === "acceptance-contract-coverage.json",
    )!;
    expect(generated).toBeDefined();
    const coverage = JSON.parse(generated.content) as {
      artifactKind: string;
      items: ReadonlyArray<Record<string, unknown>>;
      limitations: ReadonlyArray<string>;
    };
    expect(coverage.artifactKind).toBe("acceptance_contract_coverage");
    expect(coverage.items.every((item) => !("establishedBy" in item))).toBeTrue();
    expect(coverage.items.every((item) => !("result" in item))).toBeTrue();
    expect(coverage.limitations.join(" ")).toContain("records no command execution or result");
  });

  test("journey failures carry typed codes", () => {
    const failure = new JourneyFailure("usage", ["expected: generate|check"]);
    expect(failure.code).toBe("usage");
    expect(String(failure)).toContain("usage");
  });
});
