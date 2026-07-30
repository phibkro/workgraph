import type { ArtifactReference, ExactSubjectReference, GitCommitReference } from "./model.ts";

export type ReferenceProblem =
  | "empty_repository"
  | "invalid_git_object_id"
  | "empty_observer"
  | "invalid_artifact_digest"
  | "empty_media_type";

export const validateExactReference = (
  reference: ExactSubjectReference,
): ReadonlyArray<ReferenceProblem> => {
  if (reference.kind === "git_commit") {
    const expectedLength = reference.objectFormat === "sha1" ? 40 : 64;
    return [
      ...(reference.repository.length === 0 ? (["empty_repository"] as const) : []),
      ...(!new RegExp(`^[0-9a-f]{${expectedLength}}$`, "u").test(reference.objectId)
        ? (["invalid_git_object_id"] as const)
        : []),
      ...(reference.observedBy.length === 0 ? (["empty_observer"] as const) : []),
    ];
  }

  const expectedLength = reference.algorithm === "sha256" ? 64 : 128;
  return [
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

export const gitCommit = (reference: Omit<GitCommitReference, "kind">): GitCommitReference => ({
  kind: "git_commit",
  ...reference,
});
