import type {
  ArtifactReference,
  BasisReference,
  ExactSubjectReference,
  GitCommitReference,
} from "./model.ts";
import { LIFECYCLE_STATES } from "./model.ts";

export type ReferenceProblem =
  | "empty_repository"
  | "invalid_git_object_id"
  | "empty_observer"
  | "invalid_artifact_digest"
  | "empty_media_type"
  | "empty_checker"
  | "empty_checker_version"
  | "empty_machine_check_subjects"
  | "empty_acceptance_contract"
  | "empty_operation"
  | "empty_environment"
  | "inconsistent_check_disposition"
  | "empty_observation_time"
  | "empty_external_provider"
  | "empty_external_project"
  | "empty_external_record_id"
  | "missing_immutable_external_revision"
  | "empty_external_interpretation"
  | "empty_approval_actor"
  | "empty_authority_scope"
  | "empty_approval_subjects"
  | "empty_approval_rationale"
  | "empty_approval_time"
  | "empty_graph_event_id"
  | "unsupported_git_object_format"
  | "unsupported_artifact_algorithm"
  | "unknown_check_result"
  | "invalid_exit_code"
  | "invalid_approval_authentication"
  | "invalid_approval_transition"
  | "invalid_approval_evidence_markers";

export const validateExactReference = (
  reference: ExactSubjectReference,
): ReadonlyArray<ReferenceProblem> => {
  if (reference.kind === "git_commit") {
    const supportedFormat =
      reference.objectFormat === "sha1" || reference.objectFormat === "sha256";
    const expectedLength = reference.objectFormat === "sha1" ? 40 : 64;
    return [
      ...(!supportedFormat ? (["unsupported_git_object_format"] as const) : []),
      ...(reference.repository.length === 0 ? (["empty_repository"] as const) : []),
      ...(!new RegExp(`^[0-9a-f]{${expectedLength}}$`, "u").test(reference.objectId)
        ? (["invalid_git_object_id"] as const)
        : []),
      ...(reference.observedBy.length === 0 ? (["empty_observer"] as const) : []),
    ];
  }

  const supportedAlgorithm = reference.algorithm === "sha256" || reference.algorithm === "sha512";
  const expectedLength = reference.algorithm === "sha256" ? 64 : 128;
  return [
    ...(!supportedAlgorithm ? (["unsupported_artifact_algorithm"] as const) : []),
    ...(!new RegExp(`^[0-9a-f]{${expectedLength}}$`, "u").test(reference.digest)
      ? (["invalid_artifact_digest"] as const)
      : []),
    ...(reference.mediaType.length === 0 ? (["empty_media_type"] as const) : []),
  ];
};

export const sameExactReference = (
  left: ExactSubjectReference,
  right: ExactSubjectReference,
): boolean => {
  if (left.kind !== right.kind) return false;

  if (left.kind === "git_commit" && right.kind === "git_commit") {
    return (
      left.repository === right.repository &&
      left.objectFormat === right.objectFormat &&
      left.objectId === right.objectId &&
      left.path === right.path
    );
  }

  const leftArtifact = left as ArtifactReference;
  const rightArtifact = right as ArtifactReference;
  return (
    leftArtifact.algorithm === rightArtifact.algorithm &&
    leftArtifact.digest === rightArtifact.digest &&
    leftArtifact.mediaType === rightArtifact.mediaType
  );
};

/**
 * Validates the exactness fields owned by every frozen basis-reference family.
 * Graph-event existence and ordering remain graph-level checks.
 */
export const validateBasisReference = (
  reference: BasisReference,
): ReadonlyArray<ReferenceProblem> => {
  if (reference.kind === "git_commit" || reference.kind === "artifact") {
    return validateExactReference(reference);
  }

  if (reference.kind === "machine_check") {
    const knownResult =
      reference.result === "passed" ||
      reference.result === "failed" ||
      reference.result === "indeterminate";
    return [
      ...(reference.checker.length === 0 ? (["empty_checker"] as const) : []),
      ...(reference.checkerVersion.length === 0 ? (["empty_checker_version"] as const) : []),
      ...(reference.subjects.length === 0 ? (["empty_machine_check_subjects"] as const) : []),
      ...reference.subjects.flatMap(validateExactReference),
      ...(reference.policy.length === 0 ? (["empty_acceptance_contract"] as const) : []),
      ...(reference.operation.length === 0 ? (["empty_operation"] as const) : []),
      ...(reference.environment.length === 0 ? (["empty_environment"] as const) : []),
      ...(!knownResult ? (["unknown_check_result"] as const) : []),
      ...(!Number.isInteger(reference.exitCode) ? (["invalid_exit_code"] as const) : []),
      ...((reference.result === "passed" && reference.exitCode !== 0) ||
      (reference.result === "failed" && reference.exitCode === 0)
        ? (["inconsistent_check_disposition"] as const)
        : []),
      ...validateExactReference(reference.output),
      ...(reference.observedAt.length === 0 ? (["empty_observation_time"] as const) : []),
    ];
  }

  if (reference.kind === "external_record") {
    return [
      ...(reference.provider.length === 0 ? (["empty_external_provider"] as const) : []),
      ...(reference.project.length === 0 ? (["empty_external_project"] as const) : []),
      ...(reference.recordId.length === 0 ? (["empty_external_record_id"] as const) : []),
      ...(reference.observedVersion === undefined || reference.observedVersion.length === 0
        ? (["missing_immutable_external_revision"] as const)
        : []),
      ...(reference.observedAt.length === 0 ? (["empty_observation_time"] as const) : []),
      ...(reference.interpretation.length === 0
        ? (["empty_external_interpretation"] as const)
        : []),
    ];
  }

  if (reference.kind === "human_approval") {
    const knownAuthentication =
      reference.authentication === "unverified" ||
      reference.authentication === "provider_authenticated" ||
      reference.authentication === "signed";
    const knownTransition = LIFECYCLE_STATES.includes(reference.approvedTransition);
    return [
      ...(reference.actor.length === 0 ? (["empty_approval_actor"] as const) : []),
      ...(reference.authorityScope.length === 0 ? (["empty_authority_scope"] as const) : []),
      ...(!knownAuthentication ? (["invalid_approval_authentication"] as const) : []),
      ...(!knownTransition ? (["invalid_approval_transition"] as const) : []),
      ...(reference.subjects.length === 0 ? (["empty_approval_subjects"] as const) : []),
      ...reference.subjects.flatMap(validateExactReference),
      ...(reference.rationale.length === 0 ? (["empty_approval_rationale"] as const) : []),
      ...(reference.approvedAt.length === 0 ? (["empty_approval_time"] as const) : []),
      ...(reference.evidenceCategory !== "human_approved_assertion" ||
      reference.machineChecked !== false
        ? (["invalid_approval_evidence_markers"] as const)
        : []),
    ];
  }

  return reference.eventId.length === 0 ? ["empty_graph_event_id"] : [];
};

export const gitCommit = (reference: Omit<GitCommitReference, "kind">): GitCommitReference => ({
  kind: "git_commit",
  ...reference,
});
