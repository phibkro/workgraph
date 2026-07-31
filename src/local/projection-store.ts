import { deriveRoadmap } from "../core/derive.ts";
import {
  type GraphIdentity,
  type LocalWorkGraphDocument,
  validateDocumentCoherence,
} from "../core/local-command.ts";
import { immutableSnapshot, stableStringify } from "../core/normalize.ts";
import { PROJECTION_GENERATOR, projectAll, type ProjectionFile } from "../core/projections.ts";
import {
  authenticatePolicyRegistry,
  type ResolvedPolicyRegistry,
} from "../core/policy-registry.ts";
import { sha256Text } from "./document-codec.ts";
import { decodeSafeBasename, type InspectedLocalDocument } from "./store.ts";

export const LOCAL_PROJECTION_GENERATOR = `${PROJECTION_GENERATOR}+local-envelope/1`;
export const PROJECTION_MANIFEST_BASENAME = "projection-manifest.json";

export interface BuiltProjectionFile {
  readonly basename: string;
  readonly content: string;
  readonly digest: `sha256:${string}`;
}

export interface ProjectionManifest {
  readonly schemaVersion: "workgraph.projection-manifest/v1alpha1";
  readonly generator: typeof LOCAL_PROJECTION_GENERATOR;
  readonly sourceIdentity: GraphIdentity;
  readonly files: ReadonlyArray<{
    readonly basename: string;
    readonly digest: `sha256:${string}`;
  }>;
}

export interface ProjectionPointer {
  readonly schemaVersion: "workgraph.projection-pointer/v1alpha1";
  readonly snapshotBasename: string;
  readonly graphDigest: `sha256:${string}`;
  readonly revision: number;
  readonly treeDigest: `sha256:${string}`;
  readonly generator: typeof LOCAL_PROJECTION_GENERATOR;
}

export interface BuiltLocalProjection {
  readonly _tag: "ProjectionBuilt";
  readonly sourceIdentity: GraphIdentity;
  readonly files: ReadonlyArray<BuiltProjectionFile>;
  readonly manifest: BuiltProjectionFile;
  readonly treeDigest: `sha256:${string}`;
  readonly snapshotBasename: string;
  readonly pointer: ProjectionPointer;
  readonly pointerBytes: string;
}

export interface ProjectionBuildFailure {
  readonly _tag: "ProjectionBuildRejected";
  readonly code:
    | "source_coherence_rejected"
    | "source_identity_mismatch"
    | "policy_registry_rejected"
    | "projection_rejected"
    | "unsafe_projection_basename"
    | "invalid_projection_json";
  readonly detail: string;
}

export type ProjectionBuildOutcome =
  | { readonly ok: true; readonly projection: BuiltLocalProjection }
  | { readonly ok: false; readonly failure: ProjectionBuildFailure };

const rejected = (
  code: ProjectionBuildFailure["code"],
  detail: string,
): ProjectionBuildOutcome => ({
  ok: false,
  failure: immutableSnapshot({
    _tag: "ProjectionBuildRejected",
    code,
    detail,
  }),
});

const equalIdentity = (left: GraphIdentity, right: GraphIdentity): boolean =>
  left.revision === right.revision &&
  left.graphDigest === right.graphDigest &&
  left.eventChainDigest === right.eventChainDigest &&
  left.documentDigest === right.documentDigest;

const bindJsonProjection = (
  file: ProjectionFile,
  sourceIdentity: GraphIdentity,
): ProjectionFile | ProjectionBuildFailure => {
  try {
    const parsed: unknown = JSON.parse(file.content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        _tag: "ProjectionBuildRejected",
        code: "invalid_projection_json",
        detail: `${file.path} did not contain one JSON object.`,
      };
    }
    return {
      path: file.path,
      content: stableStringify({
        ...(parsed as Readonly<Record<string, unknown>>),
        graphDigest: sourceIdentity.graphDigest,
        revision: sourceIdentity.revision,
      }),
    };
  } catch {
    return {
      _tag: "ProjectionBuildRejected",
      code: "invalid_projection_json",
      detail: `${file.path} did not contain valid JSON.`,
    };
  }
};

const bindTextProjection = (
  file: ProjectionFile,
  sourceIdentity: GraphIdentity,
): ProjectionFile => {
  if (file.path.endsWith(".mmd")) {
    return {
      path: file.path,
      content: `%% graphDigest: ${sourceIdentity.graphDigest}\n%% revision: ${sourceIdentity.revision}\n${file.content}`,
    };
  }
  return {
    path: file.path,
    content: `<!-- graphDigest: ${sourceIdentity.graphDigest} -->\n<!-- revision: ${sourceIdentity.revision} -->\n${file.content}`,
  };
};

const bindProjection = (
  file: ProjectionFile,
  sourceIdentity: GraphIdentity,
): ProjectionFile | ProjectionBuildFailure =>
  file.path.endsWith(".json")
    ? bindJsonProjection(file, sourceIdentity)
    : bindTextProjection(file, sourceIdentity);

const buildAuthenticated = (
  document: LocalWorkGraphDocument,
  claimedIdentity: GraphIdentity,
  policyRegistry: ResolvedPolicyRegistry,
): ProjectionBuildOutcome => {
  const coherence = validateDocumentCoherence(document, sha256Text);
  if (!coherence.accepted || coherence.identity === undefined) {
    return rejected(
      "source_coherence_rejected",
      coherence.issues.map((issue) => issue.code).join(", ") || "unknown coherence failure",
    );
  }
  const sourceIdentity = coherence.identity;
  if (!equalIdentity(sourceIdentity, claimedIdentity)) {
    return rejected(
      "source_identity_mismatch",
      "The claimed source identity does not match the recalculated document identity.",
    );
  }
  if (!authenticatePolicyRegistry(policyRegistry, sha256Text)) {
    return rejected(
      "policy_registry_rejected",
      "The resolved policy registry does not authenticate its complete definition set.",
    );
  }

  const derivation = deriveRoadmap(document.graph, policyRegistry);
  const projected = projectAll(
    document.graph,
    derivation,
    sourceIdentity.graphDigest.slice("sha256:".length),
    policyRegistry,
  );
  if (!projected.ok) {
    return rejected(
      "projection_rejected",
      `${projected.failure.code}: ${projected.failure.detail}`,
    );
  }

  const files: Array<BuiltProjectionFile> = [];
  for (const projectedFile of projected.files) {
    const decoded = decodeSafeBasename(projectedFile.path);
    if (!decoded.ok || projectedFile.path === PROJECTION_MANIFEST_BASENAME) {
      return rejected(
        "unsafe_projection_basename",
        `The projector returned an unsafe or reserved path: ${projectedFile.path}`,
      );
    }
    const bound = bindProjection(projectedFile, sourceIdentity);
    if ("code" in bound) {
      return { ok: false, failure: immutableSnapshot(bound) };
    }
    files.push(
      immutableSnapshot({
        basename: decoded.basename,
        content: bound.content,
        digest: sha256Text(bound.content),
      }),
    );
  }
  files.sort((left, right) =>
    left.basename < right.basename ? -1 : left.basename > right.basename ? 1 : 0,
  );

  const manifestValue: ProjectionManifest = {
    schemaVersion: "workgraph.projection-manifest/v1alpha1",
    generator: LOCAL_PROJECTION_GENERATOR,
    sourceIdentity,
    files: files.map(({ basename, digest }) => ({ basename, digest })),
  };
  const manifestContent = stableStringify(manifestValue);
  const treeDigest = sha256Text(manifestContent);
  const manifest = immutableSnapshot({
    basename: PROJECTION_MANIFEST_BASENAME,
    content: manifestContent,
    digest: treeDigest,
  });
  const snapshotBasename = `snapshot-${sourceIdentity.graphDigest.slice(
    "sha256:".length,
  )}-${treeDigest.slice("sha256:".length)}`;
  const pointer = immutableSnapshot<ProjectionPointer>({
    schemaVersion: "workgraph.projection-pointer/v1alpha1",
    snapshotBasename,
    graphDigest: sourceIdentity.graphDigest,
    revision: sourceIdentity.revision,
    treeDigest,
    generator: LOCAL_PROJECTION_GENERATOR,
  });

  return {
    ok: true,
    projection: immutableSnapshot({
      _tag: "ProjectionBuilt",
      sourceIdentity,
      files,
      manifest,
      treeDigest,
      snapshotBasename,
      pointer,
      pointerBytes: stableStringify(pointer),
    }),
  };
};

/**
 * Build the exact immutable snapshot that the publication adapter will write.
 *
 * This function performs no filesystem effect. It reauthenticates the source
 * document, source identity, and policy registry before it derives any output.
 */
export const buildLocalProjection = (inspected: InspectedLocalDocument): ProjectionBuildOutcome =>
  buildAuthenticated(inspected.document, inspected.identity, inspected.policyRegistry);
