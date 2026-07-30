import type {
  ArtifactReference,
  GitCommitReference,
  HumanApprovalReference,
  MachineCheckReference,
  WorkGraph,
} from "../core/model.ts";

/**
 * Committed tracer fixture for design spec 0001.
 *
 * The fixture describes a fictional "Orchard Telemetry" project. Every
 * identity, commit, and digest is fictional and deterministic; no Semantic
 * Systems, GitHub, or Herdr semantics are imported.
 */

const REPOSITORY = "https://example.invalid/fictional/orchard-telemetry";

const commitTracer: GitCommitReference = {
  kind: "git_commit",
  repository: REPOSITORY,
  objectFormat: "sha1",
  objectId: "f00dfeedc0ffee5eedbeadfacade0fabb1e5c0de",
  observedBy: "fixture-git-object-observer/v1",
  mutableContext: "work/lag-probe-tracer",
};

const designSpecArtifact: ArtifactReference = {
  kind: "artifact",
  algorithm: "sha256",
  digest: "1a".repeat(32),
  mediaType: "text/markdown",
  producedBy: "design-freeze-editor/v1",
  locator: "design-specs/lag-probe.md",
};

const researchNoteArtifact: ArtifactReference = {
  kind: "artifact",
  algorithm: "sha256",
  digest: "2b".repeat(32),
  mediaType: "text/markdown",
  producedBy: "research-notebook/v1",
};

const researchSummaryArtifact: ArtifactReference = {
  kind: "artifact",
  algorithm: "sha256",
  digest: "3c".repeat(32),
  mediaType: "text/markdown",
  producedBy: "research-notebook/v1",
};

const decisionRecordArtifact: ArtifactReference = {
  kind: "artifact",
  algorithm: "sha256",
  digest: "4d".repeat(32),
  mediaType: "text/markdown",
  producedBy: "decision-log/v1",
};

const assumptionRecordArtifact: ArtifactReference = {
  kind: "artifact",
  algorithm: "sha256",
  digest: "5e".repeat(32),
  mediaType: "text/markdown",
  producedBy: "risk-register/v1",
};

const probeReportArtifact: ArtifactReference = {
  kind: "artifact",
  algorithm: "sha256",
  digest: "6f".repeat(32),
  mediaType: "application/json",
  producedBy: "lag-probe-check/v3",
  locator: "reports/lag-probe.json",
};

const probeCheckLogArtifact: ArtifactReference = {
  kind: "artifact",
  algorithm: "sha256",
  digest: "7a".repeat(32),
  mediaType: "text/plain",
  producedBy: "lag-probe-check/v3",
};

const gateCheckLogArtifact: ArtifactReference = {
  kind: "artifact",
  algorithm: "sha256",
  digest: "8b".repeat(32),
  mediaType: "text/plain",
  producedBy: "acceptance-runner/v2",
};

const probeMachineCheck: MachineCheckReference = {
  kind: "machine_check",
  checker: "lag-probe-check",
  checkerVersion: "3.1.4",
  subjects: [commitTracer],
  policy: "orchard.policy.probe-acceptance/v1",
  operation: "probe --replay window=24h",
  environment: "fixture-runner/linux-x64",
  result: "passed",
  exitCode: 0,
  output: probeCheckLogArtifact,
  observedAt: "2026-07-29T15:20:00Z",
};

const gateMachineCheck: MachineCheckReference = {
  kind: "machine_check",
  checker: "acceptance-runner",
  checkerVersion: "2.0.0",
  subjects: [commitTracer],
  policy: "orchard.policy.gate-0001/v1",
  operation: "accept --gate 0001",
  environment: "fixture-runner/linux-x64",
  result: "passed",
  exitCode: 0,
  output: gateCheckLogArtifact,
  observedAt: "2026-07-29T16:05:00Z",
};

const designFreezeApproval: HumanApprovalReference = {
  kind: "human_approval",
  actor: "operator:frost",
  authentication: "unverified",
  authorityScope: "project:orchard/design-freeze",
  subjects: [designSpecArtifact],
  approvedTransition: "achieved",
  rationale: "Operator freezes the lag-probe design after reading the full draft.",
  approvedAt: "2026-07-29T10:00:00Z",
  evidenceCategory: "human_approved_assertion",
  machineChecked: false,
};

export const tracerFixture: WorkGraph = {
  schemaVersion: "workgraph/v1alpha1",
  nodes: [
    { id: "project:orchard", kind: "project", title: "Orchard Telemetry" },
    { id: "ms:0001", kind: "milestone", title: "Milestone 0001: lag-probe tracer accepted" },
    {
      id: "rq:lag-attribution",
      kind: "research_question",
      title: "Can ingest lag be attributed per pipeline stage?",
    },
    {
      id: "design:lag-probe",
      kind: "design_contract",
      title: "Frozen lag-probe design",
      exactSubject: designSpecArtifact,
    },
    {
      id: "exp:lag-probe",
      kind: "work_item",
      title: "Lag-probe tracer experiment",
      exactSubject: commitTracer,
    },
    {
      id: "gate:0001-accept",
      kind: "acceptance_gate",
      title: "Tracer acceptance gate 0001",
      exactSubject: commitTracer,
    },
    {
      id: "cap:lag-attribution",
      kind: "capability",
      title: "Per-stage lag attribution",
    },
    {
      id: "cap:replay-validation",
      kind: "capability",
      title: "Replay-based validation",
    },
    {
      id: "cap:multi-region",
      kind: "capability",
      title: "Multi-region ingest attribution",
    },
    {
      id: "exp:replay-harness",
      kind: "work_item",
      title: "Alternative replay harness experiment",
    },
    {
      id: "risk:steady-clock",
      kind: "risk",
      title: "Assumption: host clocks are steady within 5ms",
    },
    {
      id: "ev:clock-skew-incident",
      kind: "evidence",
      title: "Operational clock-skew incident report",
      attributes: { category: "operational_observation" },
    },
    {
      id: "approval:design-freeze",
      kind: "human_approval",
      title: "Operator approval of the design freeze",
    },
    {
      id: "decision:evidence-first",
      kind: "decision",
      title: "Adopt the evidence-first transition flow",
    },
    {
      id: "artifact:probe-report",
      kind: "artifact",
      title: "Lag-probe run report",
      exactSubject: probeReportArtifact,
    },
    {
      id: "session:amber",
      kind: "agent_session",
      title: "Agent session amber",
    },
  ],
  edges: [
    { id: "edge:project-contains-ms", kind: "contains", from: "project:orchard", to: "ms:0001" },
    {
      id: "edge:project-contains-rq",
      kind: "contains",
      from: "project:orchard",
      to: "rq:lag-attribution",
    },
    {
      id: "edge:project-contains-cap-lag",
      kind: "contains",
      from: "project:orchard",
      to: "cap:lag-attribution",
    },
    {
      id: "edge:project-contains-cap-replay",
      kind: "contains",
      from: "project:orchard",
      to: "cap:replay-validation",
    },
    {
      id: "edge:project-contains-cap-region",
      kind: "contains",
      from: "project:orchard",
      to: "cap:multi-region",
    },
    {
      id: "edge:project-contains-replay-exp",
      kind: "contains",
      from: "project:orchard",
      to: "exp:replay-harness",
    },
    {
      id: "edge:project-contains-risk",
      kind: "contains",
      from: "project:orchard",
      to: "risk:steady-clock",
    },
    {
      id: "edge:project-contains-evidence",
      kind: "contains",
      from: "project:orchard",
      to: "ev:clock-skew-incident",
    },
    {
      id: "edge:project-contains-approval",
      kind: "contains",
      from: "project:orchard",
      to: "approval:design-freeze",
    },
    {
      id: "edge:project-contains-decision",
      kind: "contains",
      from: "project:orchard",
      to: "decision:evidence-first",
    },
    {
      id: "edge:project-contains-artifact",
      kind: "contains",
      from: "project:orchard",
      to: "artifact:probe-report",
    },
    {
      id: "edge:project-contains-session",
      kind: "contains",
      from: "project:orchard",
      to: "session:amber",
    },
    { id: "edge:ms-contains-design", kind: "contains", from: "ms:0001", to: "design:lag-probe" },
    { id: "edge:ms-contains-exp", kind: "contains", from: "ms:0001", to: "exp:lag-probe" },
    { id: "edge:ms-contains-gate", kind: "contains", from: "ms:0001", to: "gate:0001-accept" },
    {
      id: "edge:exp-implements-design",
      kind: "implements",
      from: "exp:lag-probe",
      to: "design:lag-probe",
    },
    {
      id: "edge:gate-evaluates-exp",
      kind: "evaluates",
      from: "gate:0001-accept",
      to: "exp:lag-probe",
    },
    {
      id: "edge:cap-lag-requires-design",
      kind: "requires",
      from: "cap:lag-attribution",
      to: "design:lag-probe",
    },
    {
      id: "edge:cap-lag-requires-gate",
      kind: "requires",
      from: "cap:lag-attribution",
      to: "gate:0001-accept",
    },
    {
      id: "edge:cap-lag-from-rq",
      kind: "derived_from",
      from: "cap:lag-attribution",
      to: "rq:lag-attribution",
    },
    {
      id: "edge:cap-replay-or-probe",
      kind: "requires",
      from: "cap:replay-validation",
      to: "exp:lag-probe",
      attributes: { orGroup: "realization" },
    },
    {
      id: "edge:cap-replay-or-harness",
      kind: "requires",
      from: "cap:replay-validation",
      to: "exp:replay-harness",
      attributes: { orGroup: "realization" },
    },
    {
      id: "edge:cap-region-requires-cap-lag",
      kind: "requires",
      from: "cap:multi-region",
      to: "cap:lag-attribution",
    },
    {
      id: "edge:rq-supports-design",
      kind: "supports",
      from: "rq:lag-attribution",
      to: "design:lag-probe",
    },
    {
      id: "edge:design-from-rq",
      kind: "derived_from",
      from: "design:lag-probe",
      to: "rq:lag-attribution",
    },
    {
      id: "edge:decision-supports-design",
      kind: "supports",
      from: "decision:evidence-first",
      to: "design:lag-probe",
    },
    {
      id: "edge:approval-supports-design",
      kind: "supports",
      from: "approval:design-freeze",
      to: "design:lag-probe",
    },
    {
      id: "edge:incident-contradicts-assumption",
      kind: "contradicts",
      from: "ev:clock-skew-incident",
      to: "risk:steady-clock",
    },
    {
      id: "edge:assumption-blocks-replay",
      kind: "blocks",
      from: "risk:steady-clock",
      to: "exp:replay-harness",
    },
    {
      id: "edge:report-from-exp",
      kind: "derived_from",
      from: "artifact:probe-report",
      to: "exp:lag-probe",
    },
    {
      id: "edge:exp-observed-by-session",
      kind: "observed_by",
      from: "exp:lag-probe",
      to: "session:amber",
    },
  ],
  events: [
    {
      id: "event:rq-active",
      subjectId: "rq:lag-attribution",
      priorState: null,
      requestedState: "active",
      transitionKind: "advance",
      actor: "operator:frost",
      authority: "administrative_assertion",
      evidenceCategory: "agent_assertion",
      basis: [researchNoteArtifact],
      policy: "workgraph.policy.administrative",
      policyVersion: "1",
      rationale: "Research opened; the note artifact records the framing.",
      observedAt: "2026-07-28T09:00:00Z",
    },
    {
      id: "event:decision-adopted",
      subjectId: "decision:evidence-first",
      priorState: null,
      requestedState: "achieved",
      transitionKind: "advance",
      actor: "operator:frost",
      authority: "administrative_assertion",
      evidenceCategory: "agent_assertion",
      basis: [decisionRecordArtifact],
      policy: "workgraph.policy.administrative",
      policyVersion: "1",
      rationale: "Decision recorded as an operator assertion, not a machine result.",
      observedAt: "2026-07-28T10:00:00Z",
    },
    {
      id: "event:risk-assumed",
      subjectId: "risk:steady-clock",
      priorState: null,
      requestedState: "achieved",
      transitionKind: "advance",
      actor: "operator:frost",
      authority: "administrative_assertion",
      evidenceCategory: "assumption",
      basis: [assumptionRecordArtifact],
      policy: "workgraph.policy.administrative",
      policyVersion: "1",
      rationale: "The steady-clock assumption is accepted as holding, explicitly as an assumption.",
      observedAt: "2026-07-28T11:00:00Z",
    },
    {
      id: "event:rq-achieved",
      subjectId: "rq:lag-attribution",
      priorState: "active",
      requestedState: "achieved",
      transitionKind: "advance",
      actor: "operator:frost",
      authority: "administrative_assertion",
      evidenceCategory: "agent_assertion",
      basis: [researchSummaryArtifact],
      policy: "workgraph.policy.administrative",
      policyVersion: "1",
      rationale: "Research concluded; the summary artifact is an assertion, not a machine check.",
      observedAt: "2026-07-28T17:00:00Z",
    },
    {
      id: "event:session-active",
      subjectId: "session:amber",
      priorState: null,
      requestedState: "active",
      transitionKind: "advance",
      actor: "adapter:terminal-multiplexer",
      authority: "imported_observation",
      evidenceCategory: "external_observation",
      basis: [
        {
          kind: "external_record",
          provider: "fictional-terminal-multiplexer",
          project: "orchard",
          recordId: "session/amber-7",
          observedVersion: "42",
          observedAt: "2026-07-29T08:00:00Z",
          interpretation:
            "The provider reports a live session; this is an observation about the provider only.",
        },
      ],
      policy: "workgraph.policy.imported-observation",
      policyVersion: "1",
      rationale: "An external session record was observed; it asserts liveness, nothing more.",
      observedAt: "2026-07-29T08:00:05Z",
    },
    {
      id: "event:exp-active",
      subjectId: "exp:lag-probe",
      priorState: null,
      requestedState: "active",
      transitionKind: "advance",
      actor: "adapter:terminal-multiplexer",
      authority: "imported_observation",
      evidenceCategory: "external_observation",
      basis: [
        commitTracer,
        {
          kind: "external_record",
          provider: "fictional-terminal-multiplexer",
          project: "orchard",
          recordId: "session/amber-7",
          observedVersion: "43",
          observedAt: "2026-07-29T08:10:00Z",
          interpretation: "The session record names this experiment as its working subject.",
        },
      ],
      policy: "workgraph.policy.imported-observation",
      policyVersion: "1",
      rationale: "The observed session started work on the experiment's exact commit.",
      observedAt: "2026-07-29T08:10:05Z",
    },
    {
      id: "event:design-achieved",
      subjectId: "design:lag-probe",
      priorState: null,
      requestedState: "achieved",
      transitionKind: "advance",
      actor: "operator:frost",
      authority: "human_approval",
      evidenceCategory: "human_approved_assertion",
      basis: [designFreezeApproval],
      policy: "workgraph.policy.human-approval",
      policyVersion: "1",
      rationale:
        "The operator approved the design freeze. This is a human-approved assertion and is not machine checked.",
      observedAt: "2026-07-29T10:00:05Z",
    },
    {
      id: "event:approval-recorded",
      subjectId: "approval:design-freeze",
      priorState: null,
      requestedState: "achieved",
      transitionKind: "advance",
      actor: "operator:frost",
      authority: "human_approval",
      evidenceCategory: "human_approved_assertion",
      basis: [designFreezeApproval],
      policy: "workgraph.policy.human-approval",
      policyVersion: "1",
      rationale: "The approval record itself is recorded as a human-approved assertion.",
      observedAt: "2026-07-29T10:00:06Z",
    },
    {
      id: "event:exp-achieved",
      subjectId: "exp:lag-probe",
      priorState: "active",
      requestedState: "achieved",
      transitionKind: "advance",
      actor: "workgraph.policy.machine-check/v1",
      authority: "machine_policy",
      evidenceCategory: "machine_check",
      basis: [probeMachineCheck],
      policy: "workgraph.policy.machine-check",
      policyVersion: "1",
      rationale: "The bound probe check passed against the exact tracer commit.",
      observedAt: "2026-07-29T15:20:05Z",
    },
    {
      id: "event:gate-achieved",
      subjectId: "gate:0001-accept",
      priorState: null,
      requestedState: "achieved",
      transitionKind: "advance",
      actor: "workgraph.policy.machine-check/v1",
      authority: "machine_policy",
      evidenceCategory: "machine_check",
      basis: [gateMachineCheck],
      policy: "workgraph.policy.machine-check",
      policyVersion: "1",
      rationale: "The acceptance gate's bound runner passed against the exact tracer commit.",
      observedAt: "2026-07-29T16:05:05Z",
    },
    {
      id: "event:report-registered",
      subjectId: "artifact:probe-report",
      priorState: null,
      requestedState: "achieved",
      transitionKind: "advance",
      actor: "operator:frost",
      authority: "administrative_assertion",
      evidenceCategory: "agent_assertion",
      basis: [probeReportArtifact],
      policy: "workgraph.policy.administrative",
      policyVersion: "1",
      rationale: "The report artifact is registered by digest; the digest is its identity.",
      observedAt: "2026-07-29T16:10:00Z",
    },
    {
      id: "event:clock-skew-observed",
      subjectId: "ev:clock-skew-incident",
      priorState: null,
      requestedState: "achieved",
      transitionKind: "advance",
      actor: "adapter:ops-import",
      authority: "imported_observation",
      evidenceCategory: "external_observation",
      basis: [
        {
          kind: "external_record",
          provider: "fictional-ops-monitor",
          project: "orchard",
          recordId: "incident/2026-07-30-clock-skew",
          observedAt: "2026-07-30T02:00:00Z",
          interpretation:
            "The monitor reports 40ms clock skew across hosts, contradicting the steady-clock assumption.",
        },
      ],
      policy: "workgraph.policy.imported-observation",
      policyVersion: "1",
      rationale:
        "A failing operational observation was imported. Earlier accepted history is preserved; a revision frontier is derived instead.",
      observedAt: "2026-07-30T02:00:05Z",
    },
  ],
  requests: [
    {
      id: "request:activate-replay",
      subjectId: "exp:replay-harness",
      requestedState: "active",
      declaredBy: "agent:amber",
      declaredInRepository: REPOSITORY,
      rationale:
        "A commit declares intent to start the replay harness. No observer event references a resulting immutable commit yet, so no state change occurs.",
    },
  ],
};

export const fixtureCommit = commitTracer;
export const fixtureDesignArtifact = designSpecArtifact;
export const fixtureProbeCheck = probeMachineCheck;
export const fixtureApproval = designFreezeApproval;
