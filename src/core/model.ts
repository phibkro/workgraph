export const NODE_KINDS = [
  "project",
  "milestone",
  "capability",
  "research_question",
  "design_contract",
  "work_item",
  "decision",
  "risk",
  "acceptance_gate",
  "artifact",
  "evidence",
  "human_approval",
  "agent_session",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  "contains",
  "requires",
  "blocks",
  "enables",
  "implements",
  "evaluates",
  "supports",
  "contradicts",
  "derived_from",
  "supersedes",
  "owned_by",
  "assigned_to",
  "observed_by",
] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

export const LIFECYCLE_STATES = [
  "declared",
  "active",
  "waiting",
  "blocked",
  "achieved",
  "stale",
  "abandoned",
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export type GitObjectFormat = "sha1" | "sha256";

export interface GitCommitReference {
  readonly kind: "git_commit";
  readonly repository: string;
  readonly objectFormat: GitObjectFormat;
  readonly objectId: string;
  readonly observedBy: string;
  readonly path?: string;
  readonly mutableContext?: string;
}

export interface ArtifactReference {
  readonly kind: "artifact";
  readonly algorithm: "sha256" | "sha512";
  readonly digest: string;
  readonly mediaType: string;
  readonly producedBy?: string;
  readonly locator?: string;
}

export interface MachineCheckReference {
  readonly kind: "machine_check";
  readonly checker: string;
  readonly checkerVersion: string;
  readonly subjects: ReadonlyArray<ExactSubjectReference>;
  readonly policy: string;
  readonly operation: string;
  readonly environment: string;
  readonly result: "passed" | "failed" | "indeterminate";
  readonly exitCode: number;
  readonly output: ArtifactReference;
  readonly observedAt: string;
}

export interface ExternalRecordReference {
  readonly kind: "external_record";
  readonly provider: string;
  readonly project: string;
  readonly recordId: string;
  readonly observedVersion?: string;
  readonly observedAt: string;
  readonly interpretation: string;
}

export interface HumanApprovalReference {
  readonly kind: "human_approval";
  readonly actor: string;
  readonly authentication: "unverified" | "provider_authenticated" | "signed";
  readonly authorityScope: string;
  readonly subjects: ReadonlyArray<ExactSubjectReference>;
  readonly approvedTransition: LifecycleState;
  readonly rationale: string;
  readonly approvedAt: string;
  readonly evidenceCategory: "human_approved_assertion";
  readonly machineChecked: false;
}

export interface GraphEventReference {
  readonly kind: "graph_event";
  readonly eventId: string;
}

export type ExactSubjectReference = GitCommitReference | ArtifactReference;

export type BasisReference =
  | ExactSubjectReference
  | MachineCheckReference
  | ExternalRecordReference
  | HumanApprovalReference
  | GraphEventReference;

export interface WorkNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly title: string;
  readonly exactSubject?: ExactSubjectReference;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface WorkEdge {
  readonly id: string;
  readonly kind: EdgeKind;
  readonly from: string;
  readonly to: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export type AuthorityKind =
  | "machine_policy"
  | "human_approval"
  | "imported_observation"
  | "administrative_assertion";

export type EvidenceCategory =
  | "machine_check"
  | "human_approved_assertion"
  | "external_observation"
  | "agent_assertion"
  | "assumption";

export interface TransitionEvent {
  readonly id: string;
  readonly subjectId: string;
  readonly priorState: LifecycleState | null;
  readonly requestedState: LifecycleState;
  readonly transitionKind: "advance" | "reopen" | "correct";
  readonly actor: string;
  readonly authority: AuthorityKind;
  readonly evidenceCategory: EvidenceCategory;
  readonly basis: readonly [BasisReference, ...ReadonlyArray<BasisReference>];
  readonly policy: string;
  readonly policyVersion: string;
  readonly rationale: string;
  readonly observedAt: string;
  readonly supersedes?: string;
}

export interface WorkGraph {
  readonly schemaVersion: "workgraph/v1alpha1";
  readonly nodes: ReadonlyArray<WorkNode>;
  readonly edges: ReadonlyArray<WorkEdge>;
  readonly events: ReadonlyArray<TransitionEvent>;
}
