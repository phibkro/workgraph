import { describe, expect, test } from "bun:test";
import type {
  GitCommitReference,
  MachineCheckReference,
  TransitionEvent,
  WorkGraph,
} from "../src/core/model.ts";
import { reduceLifecycle, validateGraph } from "../src/core/graph.ts";

const commitA: GitCommitReference = {
  kind: "git_commit",
  repository: "https://example.invalid/workgraph",
  objectFormat: "sha1",
  objectId: "a".repeat(40),
  observedBy: "git-object-observer/v1",
};

const output = {
  kind: "artifact" as const,
  algorithm: "sha256" as const,
  digest: "c".repeat(64),
  mediaType: "text/plain",
};

const passingCheck = (subject: GitCommitReference): MachineCheckReference => ({
  kind: "machine_check",
  checker: "workgraph-fixture-check",
  checkerVersion: "1",
  subjects: [subject],
  policy: "workgraph.policy.machine-check/v1",
  operation: "bun test",
  environment: "fixture-env",
  result: "passed",
  exitCode: 0,
  output,
  observedAt: "2026-07-30T12:00:00Z",
});

const transition = (overrides: Partial<TransitionEvent> = {}): TransitionEvent => ({
  id: "event:artifact-achieved",
  subjectId: "artifact:a",
  priorState: null,
  requestedState: "achieved",
  transitionKind: "advance",
  actor: "workgraph.policy.machine-check/v1",
  authority: "machine_policy",
  evidenceCategory: "machine_check",
  basis: [passingCheck(commitA)],
  policy: "workgraph.policy.machine-check",
  policyVersion: "1",
  rationale: "The exact artifact passed its acceptance check.",
  observedAt: "2026-07-30T12:00:01Z",
  ...overrides,
});

const graph = (overrides: Partial<WorkGraph> = {}): WorkGraph => ({
  schemaVersion: "workgraph/v1alpha1",
  nodes: [
    {
      id: "artifact:a",
      kind: "artifact",
      title: "Artifact A",
      exactSubject: commitA,
    },
  ],
  edges: [],
  events: [transition()],
  ...overrides,
});

describe("canonical graph validation", () => {
  test("accepts a machine transition bound to the exact subject", () => {
    const result = validateGraph(graph());

    expect(result).toEqual({ accepted: true, issues: [] });
    expect(reduceLifecycle(graph()).get("artifact:a")).toBe("achieved");
  });

  test("rejects a branch name in place of a full commit object id", () => {
    const weak = { ...commitA, objectId: "main", mutableContext: "main" };
    const result = validateGraph(
      graph({
        nodes: [{ id: "artifact:a", kind: "artifact", title: "Artifact A", exactSubject: weak }],
        events: [transition({ basis: [passingCheck(weak)] })],
      }),
    );

    expect(result.accepted).toBeFalse();
    expect(result.issues.map((issue) => issue.code)).toContain("invalid_git_object_id");
  });

  test("rejects a check for commit A when the subject is commit B", () => {
    const commitB = { ...commitA, objectId: "b".repeat(40) };
    const result = validateGraph(
      graph({
        nodes: [{ id: "artifact:a", kind: "artifact", title: "Artifact B", exactSubject: commitB }],
      }),
    );

    expect(result.accepted).toBeFalse();
    expect(result.issues.map((issue) => issue.code)).toContain("exact_subject_mismatch");
  });

  test("keeps human approval distinct from machine checking", () => {
    const approval = {
      kind: "human_approval" as const,
      actor: "operator",
      authentication: "unverified" as const,
      authorityScope: "project",
      subjects: [commitA],
      approvedTransition: "achieved" as const,
      rationale: "Operator accepts the bounded result.",
      approvedAt: "2026-07-30T12:00:00Z",
      evidenceCategory: "human_approved_assertion" as const,
      machineChecked: false as const,
    };
    const result = validateGraph(
      graph({
        events: [
          transition({
            authority: "human_approval",
            evidenceCategory: "human_approved_assertion",
            basis: [approval],
          }),
        ],
      }),
    );

    expect(result).toEqual({ accepted: true, issues: [] });
    expect(approval.machineChecked).toBeFalse();
  });

  test("accepts feedback cycles but rejects requires cycles", () => {
    const nodes = [
      { id: "research", kind: "research_question" as const, title: "Research" },
      { id: "experiment", kind: "work_item" as const, title: "Experiment" },
    ];
    const feedback = graph({
      nodes,
      events: [],
      edges: [
        { id: "supports", kind: "supports", from: "research", to: "experiment" },
        { id: "contradicts", kind: "contradicts", from: "experiment", to: "research" },
      ],
    });
    const dependencyCycle = {
      ...feedback,
      edges: [
        { id: "requires-a", kind: "requires" as const, from: "research", to: "experiment" },
        { id: "requires-b", kind: "requires" as const, from: "experiment", to: "research" },
      ],
    };

    expect(validateGraph(feedback).accepted).toBeTrue();
    expect(validateGraph(dependencyCycle).issues.map((issue) => issue.code)).toContain(
      "requires_cycle",
    );
  });

  test("preserves and explicitly references superseded events", () => {
    const correction = transition({
      id: "event:artifact-corrected",
      priorState: "achieved",
      requestedState: "stale",
      transitionKind: "correct",
      supersedes: "event:artifact-achieved",
      basis: [{ kind: "graph_event", eventId: "event:artifact-achieved" }, commitA],
      authority: "administrative_assertion",
      evidenceCategory: "agent_assertion",
    });
    const result = validateGraph(graph({ events: [transition(), correction] }));

    expect(result.accepted).toBeTrue();
    expect(reduceLifecycle(graph({ events: [transition(), correction] })).get("artifact:a")).toBe(
      "stale",
    );
  });
});
