import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createGenesisDocument,
  validateDocumentCoherence,
  type GraphIdentity,
  type LocalWorkGraphDocument,
} from "../src/core/local-command.ts";
import type { TransitionEvent, WorkGraph } from "../src/core/model.ts";
import {
  attachPolicyRegistryDigest,
  resolvePolicyRegistry,
  type ResolvedPolicyRegistry,
} from "../src/core/policy-registry.ts";
import { sha256Text } from "../src/local/document-codec.ts";
import {
  buildLocalProjection,
  LOCAL_PROJECTION_GENERATOR,
  type BuiltLocalProjection,
} from "../src/local/projection-store.ts";
import type { InspectedLocalDocument } from "../src/local/store.ts";

const graph = (events: ReadonlyArray<TransitionEvent> = []): WorkGraph => ({
  schemaVersion: "workgraph/v1alpha1",
  nodes: [{ id: "work:one", kind: "work_item", title: "One" }],
  edges: [],
  events,
  requests: [],
});

const registryResolution = resolvePolicyRegistry();
if (!registryResolution.ok) throw new Error("generic policy registry rejected");
const registry = attachPolicyRegistryDigest(registryResolution, sha256Text);

const inspected = (
  document: LocalWorkGraphDocument,
  identity: GraphIdentity,
  policyRegistry: ResolvedPolicyRegistry = registry,
): InspectedLocalDocument => ({
  _tag: "Inspected",
  fileBasename: "workgraph.json" as InspectedLocalDocument["fileBasename"],
  fileObservation: {
    _tag: "Exact",
    device: 1,
    inode: 1,
    linkCount: 1,
    contentDigest: sha256Text("fixture"),
  },
  identity,
  revision: document.revision,
  policyRegistry,
  document,
});

const acceptedBuild = (document: LocalWorkGraphDocument): BuiltLocalProjection => {
  const coherence = validateDocumentCoherence(document, sha256Text);
  assert.equal(coherence.accepted, true);
  assert.notEqual(coherence.identity, undefined);
  const outcome = buildLocalProjection(inspected(document, coherence.identity!));
  if (!outcome.ok) throw new Error(outcome.failure.detail);
  assert.equal(outcome.ok, true);
  return outcome.projection;
};

test("projection build is deterministic and every file carries source identity", () => {
  const document = createGenesisDocument(graph(), sha256Text);
  const first = acceptedBuild(document);
  const second = acceptedBuild(document);

  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.files), true);
  assert.equal(first.pointer.generator, LOCAL_PROJECTION_GENERATOR);
  assert.equal(first.pointer.graphDigest, document.graphDigest);
  assert.equal(first.pointer.revision, 0);
  assert.equal(first.pointer.treeDigest, first.treeDigest);
  assert.equal(first.manifest.digest, first.treeDigest);
  assert.equal(
    first.treeDigest,
    "sha256:5651a2e2b7e2edd92a4c35c99ae57c2fa486cc9dd3c1070de02607ea2bc0c511",
  );
  assert.equal(
    sha256Text(first.pointerBytes),
    "sha256:85fae556fd25b343f7bf62dedbd0f5f82076d673479694f05f9982fe5bb23447",
  );
  assert.match(
    first.snapshotBasename,
    new RegExp(`^snapshot-${document.graphDigest.slice("sha256:".length)}-[0-9a-f]{64}$`, "u"),
  );

  for (const file of first.files) {
    assert.equal(file.digest, sha256Text(file.content));
    if (file.basename.endsWith(".json")) {
      const value = JSON.parse(file.content);
      assert.equal(value.graphDigest, document.graphDigest);
      assert.equal(value.revision, 0);
    } else {
      assert.match(file.content, new RegExp(document.graphDigest, "u"));
      assert.match(file.content, /revision: 0/u);
    }
  }
});

test("manifest binds every sorted file and excludes itself", () => {
  const projection = acceptedBuild(createGenesisDocument(graph(), sha256Text));
  const manifest = JSON.parse(projection.manifest.content) as {
    readonly sourceIdentity: GraphIdentity;
    readonly files: ReadonlyArray<{ readonly basename: string; readonly digest: string }>;
  };
  assert.deepEqual(
    manifest.files.map(({ basename }) => basename),
    projection.files.map(({ basename }) => basename).toSorted(),
  );
  assert.equal(
    manifest.files.some(({ basename }) => basename === projection.manifest.basename),
    false,
  );
  assert.deepEqual(manifest.sourceIdentity, projection.sourceIdentity);
});

test("a source change produces a different graph, tree, snapshot, and pointer identity", () => {
  const first = acceptedBuild(createGenesisDocument(graph(), sha256Text));
  const changedGraph: WorkGraph = {
    ...graph(),
    nodes: [{ id: "work:one", kind: "work_item", title: "Changed" }],
  };
  const second = acceptedBuild(createGenesisDocument(changedGraph, sha256Text));

  assert.notEqual(first.sourceIdentity.graphDigest, second.sourceIdentity.graphDigest);
  assert.notEqual(first.treeDigest, second.treeDigest);
  assert.notEqual(first.snapshotBasename, second.snapshotBasename);
  assert.notEqual(first.pointerBytes, second.pointerBytes);
});

test("projection build reauthenticates source identity and policy registry", () => {
  const document = createGenesisDocument(graph(), sha256Text);
  const coherence = validateDocumentCoherence(document, sha256Text);
  assert.notEqual(coherence.identity, undefined);
  const identity = coherence.identity!;

  const forgedIdentity = buildLocalProjection(
    inspected(document, {
      ...identity,
      graphDigest: `sha256:${"0".repeat(64)}`,
    }),
  );
  assert.deepEqual(forgedIdentity, {
    ok: false,
    failure: {
      _tag: "ProjectionBuildRejected",
      code: "source_identity_mismatch",
      detail: "The claimed source identity does not match the recalculated document identity.",
    },
  });

  const forgedRegistry = {
    ...registry,
    digest: `sha256:${"0".repeat(64)}`,
  } as ResolvedPolicyRegistry;
  const registryOutcome = buildLocalProjection(inspected(document, identity, forgedRegistry));
  assert.equal(registryOutcome.ok, false);
  if (!registryOutcome.ok) {
    assert.equal(registryOutcome.failure.code, "policy_registry_rejected");
  }

  const incoherentDocument = {
    ...document,
    revision: 1,
  };
  const incoherent = buildLocalProjection(
    inspected(incoherentDocument, identity) as InspectedLocalDocument,
  );
  assert.equal(incoherent.ok, false);
  if (!incoherent.ok) {
    assert.equal(incoherent.failure.code, "source_coherence_rejected");
  }
});
