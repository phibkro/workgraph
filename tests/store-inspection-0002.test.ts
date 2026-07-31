import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Effect, Result } from "effect";
import { runLocalCli } from "../src/cli/local-command.ts";
import { createGenesisDocument, type LocalWorkGraphDocument } from "../src/core/local-command.ts";
import type { WorkGraph } from "../src/core/model.ts";
import { attachPolicyRegistryDigest, resolvePolicyRegistry } from "../src/core/policy-registry.ts";
import { encodeLocalDocument, sha256Text } from "../src/local/document-codec.ts";
import {
  LocalFileStore,
  makeLocalFileStore,
  type ExclusiveFenceLockApi,
  type InspectLocalDocumentRequest,
  type LocalFileStoreApi,
} from "../src/local/store.ts";

const fixtureRoot = join(
  tmpdir(),
  `workgraph-store-inspection-${process.pid}-${crypto.randomUUID()}`,
);

const graph = (overrides: Partial<WorkGraph> = {}): WorkGraph => ({
  schemaVersion: "workgraph/v1alpha1",
  nodes: [{ id: "work:one", kind: "work_item", title: "One" }],
  edges: [],
  events: [],
  requests: [],
  ...overrides,
});

const runtimeFence = async (): Promise<ExclusiveFenceLockApi> => {
  if (typeof Bun !== "undefined") {
    return (await import("../src/local/bun-file-store.ts")).makeBunExclusiveFenceLock();
  }
  return (await import("../src/local/node-file-store.ts")).makeNodeExclusiveFenceLock();
};

let store: LocalFileStoreApi;

before(async () => {
  await mkdir(fixtureRoot);
  store = makeLocalFileStore(await runtimeFence());
});

after(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(fixtureRoot, { recursive: true, force: true });
});

const writeDocument = async (
  directory: string,
  document: LocalWorkGraphDocument,
): Promise<string> => {
  const source = encodeLocalDocument(document);
  await writeFile(join(directory, "workgraph.json"), source);
  return source;
};

const inspectResult = (request: InspectLocalDocumentRequest) =>
  Effect.runPromise(Effect.result(store.inspectLocalDocument(request)));

test("inspection returns exact immutable document, graph, file, and registry identities", async () => {
  const rootPath = join(fixtureRoot, "accepted");
  await mkdir(rootPath);
  const document = createGenesisDocument(graph(), sha256Text);
  const source = await writeDocument(rootPath, document);
  const policySource = JSON.stringify({
    schemaVersion: "workgraph.policy-definitions/v1alpha1",
    definitions: [
      {
        id: "example.policy",
        version: "1",
        authority: "administrative_assertion",
        evidenceCategory: "agent_assertion",
        rules: [
          {
            priorState: null,
            requestedState: "active",
            transitionKind: "advance",
          },
        ],
      },
    ],
  });
  await writeFile(join(rootPath, "policies.json"), policySource);

  const inspected = await Effect.runPromise(
    store.inspectLocalDocument({
      rootPath,
      fileBasename: "workgraph.json",
      policyBasename: "policies.json",
    }),
  );
  const resolution = resolvePolicyRegistry([
    {
      id: "example.policy",
      version: "1",
      authority: "administrative_assertion",
      evidenceCategory: "agent_assertion",
      rules: [{ priorState: null, requestedState: "active", transitionKind: "advance" }],
    },
  ]);
  assert.equal(resolution.ok, true);
  if (!resolution.ok) throw new Error("expected registry resolution");
  const expectedRegistry = attachPolicyRegistryDigest(resolution, sha256Text);

  assert.equal(Reflect.get(inspected, "_tag"), "Inspected");
  assert.equal(inspected.revision, 0);
  assert.equal(inspected.identity.revision, 0);
  assert.equal(inspected.identity.graphDigest, document.graphDigest);
  assert.equal(inspected.policyRegistry.digest, expectedRegistry.digest);
  assert.equal(inspected.fileObservation.linkCount, 1);
  assert.equal(
    inspected.fileObservation.contentDigest,
    `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`,
  );
  assert.equal(
    inspected.policyFile?.observation.contentDigest,
    `sha256:${createHash("sha256").update(policySource, "utf8").digest("hex")}`,
  );
  assert.deepEqual(inspected.document, document);
  assert.equal(Object.isFrozen(inspected), true);
  assert.equal(Object.isFrozen(inspected.document.graph), true);
  assert.equal(Reflect.set(inspected.document, "revision", 1), false);
});

test("the shared local CLI emits one deterministic JSON inspection outcome", async () => {
  const rootPath = join(fixtureRoot, "cli-inspection");
  await mkdir(rootPath);
  const document = createGenesisDocument(graph(), sha256Text);
  await writeDocument(rootPath, document);

  const inspect = () =>
    Effect.runPromise(
      runLocalCli(["inspect", "--root", rootPath, "--file", "workgraph.json"]).pipe(
        Effect.provideService(LocalFileStore, store),
      ),
    );
  const first = await inspect();
  const second = await inspect();
  assert.equal(first.exitCode, 0);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stdout.endsWith("\n"), true);
  const decoded = JSON.parse(first.stdout) as {
    readonly revision: number;
    readonly identity: { readonly graphDigest: string };
  };
  assert.equal(Reflect.get(decoded, "_tag"), "Inspected");
  assert.equal(decoded.revision, 0);
  assert.equal(decoded.identity.graphDigest, document.graphDigest);

  const absent = await Effect.runPromise(
    runLocalCli(["inspect", "--root", rootPath, "--file", "absent.json"]).pipe(
      Effect.provideService(LocalFileStore, store),
    ),
  );
  assert.equal(absent.exitCode, 2);
  assert.equal(JSON.parse(absent.stdout).code, "child_absent");

  const invalid = await Effect.runPromise(
    runLocalCli(["inspect", "--root", rootPath, "--file"]).pipe(
      Effect.provideService(LocalFileStore, store),
    ),
  );
  assert.equal(invalid.exitCode, 64);
  assert.equal(JSON.parse(invalid.stdout).code, "invalid_cli_use");
});

test("inspection keeps request, absence, other-file, and document failures typed", async () => {
  const rootPath = join(fixtureRoot, "typed-rejections");
  await mkdir(rootPath);
  await mkdir(join(rootPath, "directory.json"));
  await writeFile(join(rootPath, "malformed.json"), "{");
  await writeFile(join(rootPath, "invalid-utf8.json"), Uint8Array.from([0xff]));

  const invalidRequest = await inspectResult({
    rootPath,
    fileBasename: "missing.json",
    extra: true,
  } as InspectLocalDocumentRequest);
  assert.equal(Result.isFailure(invalidRequest), true);
  if (Result.isFailure(invalidRequest)) {
    assert.equal(invalidRequest.failure.code, "invalid_inspection_request");
  }

  const unsafeBasename = await inspectResult({
    rootPath: join(fixtureRoot, "root-that-must-not-open"),
    fileBasename: "../workgraph.json",
  });
  assert.equal(Result.isFailure(unsafeBasename), true);
  if (Result.isFailure(unsafeBasename)) {
    assert.equal(unsafeBasename.failure.code, "unsafe_basename");
  }

  const absent = await inspectResult({ rootPath, fileBasename: "missing.json" });
  assert.equal(Result.isFailure(absent), true);
  if (Result.isFailure(absent)) assert.equal(absent.failure.code, "child_absent");

  const other = await inspectResult({ rootPath, fileBasename: "directory.json" });
  assert.equal(Result.isFailure(other), true);
  if (Result.isFailure(other)) assert.equal(other.failure.code, "child_not_regular");

  const malformed = await inspectResult({ rootPath, fileBasename: "malformed.json" });
  assert.equal(Result.isFailure(malformed), true);
  if (Result.isFailure(malformed)) {
    assert.equal(malformed.failure.code, "document_decode_failed");
  }

  const invalidUtf8 = await inspectResult({
    rootPath,
    fileBasename: "invalid-utf8.json",
  });
  assert.equal(Result.isFailure(invalidUtf8), true);
  if (Result.isFailure(invalidUtf8)) {
    assert.equal(invalidUtf8.failure.code, "document_decode_failed");
    assert.deepEqual("issues" in invalidUtf8.failure ? invalidUtf8.failure.issues : [], [
      {
        path: "$",
        code: "invalid_utf8",
        detail: "The input is not valid UTF-8.",
      },
    ]);
  }
});

test("inspection request custody rejects proxies, accessors, and hidden fields as typed failures", async () => {
  const rootPath = join(fixtureRoot, "request-custody");
  await mkdir(rootPath);
  await writeDocument(rootPath, createGenesisDocument(graph(), sha256Text));

  const expectInvalid = async (candidate: unknown) => {
    const outcome = await inspectResult(candidate as InspectLocalDocumentRequest);
    assert.equal(Result.isFailure(outcome), true);
    if (Result.isFailure(outcome)) {
      assert.equal(Reflect.get(outcome.failure, "_tag"), "Rejected");
      assert.equal(outcome.failure.code, "invalid_inspection_request");
    }
  };

  const throwingProxy = new Proxy(
    { rootPath, fileBasename: "workgraph.json" },
    {
      getPrototypeOf() {
        throw new Error("trap must not become a defect");
      },
      ownKeys() {
        throw new Error("trap must not become a defect");
      },
      getOwnPropertyDescriptor() {
        throw new Error("trap must not become a defect");
      },
    },
  );
  await expectInvalid(throwingProxy);

  const wellBehavedProxy = new Proxy({ rootPath, fileBasename: "workgraph.json" }, {});
  await expectInvalid(wellBehavedProxy);

  let accessorReads = 0;
  const withAccessor = {};
  Object.defineProperty(withAccessor, "rootPath", {
    enumerable: true,
    configurable: true,
    get: () => {
      accessorReads += 1;
      return rootPath;
    },
  });
  Object.defineProperty(withAccessor, "fileBasename", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: "workgraph.json",
  });
  await expectInvalid(withAccessor);
  assert.equal(accessorReads, 0);

  const hiddenExtra = { rootPath, fileBasename: "workgraph.json" };
  Object.defineProperty(hiddenExtra, "extra", {
    enumerable: false,
    configurable: true,
    value: "hidden",
  });
  await expectInvalid(hiddenExtra);

  const hiddenRequired = { fileBasename: "workgraph.json" };
  Object.defineProperty(hiddenRequired, "rootPath", {
    enumerable: false,
    configurable: true,
    value: rootPath,
  });
  await expectInvalid(hiddenRequired);

  await expectInvalid({ rootPath, fileBasename: "workgraph.json", [Symbol("hidden")]: true });
  await expectInvalid({ fileBasename: "workgraph.json" });
  await expectInvalid({ rootPath });
  await expectInvalid({ rootPath, fileBasename: 7 });
  await expectInvalid({ rootPath: "", fileBasename: "workgraph.json" });
  await expectInvalid({ rootPath: `${rootPath}\0`, fileBasename: "workgraph.json" });
  await expectInvalid({ rootPath, fileBasename: "workgraph.json", policyBasename: "a\0b" });
  await expectInvalid(Object.assign(Object.create(null), { fileBasename: "workgraph.json" }));
  await expectInvalid([rootPath, "workgraph.json"]);
  await expectInvalid(null);

  const nullPrototype = Object.assign(Object.create(null) as object, {
    rootPath,
    fileBasename: "workgraph.json",
  });
  const accepted = await inspectResult(nullPrototype as InspectLocalDocumentRequest);
  assert.equal(Result.isSuccess(accepted), true);
});

test("mutation or aliasing after Effect construction cannot change the inspected root or file", async () => {
  const chosenRoot = join(fixtureRoot, "chosen-root");
  const decoyRoot = join(fixtureRoot, "decoy-root");
  await mkdir(chosenRoot);
  await mkdir(decoyRoot);
  const chosenDocument = createGenesisDocument(graph(), sha256Text);
  const decoyDocument = createGenesisDocument(
    graph({ nodes: [{ id: "work:decoy", kind: "work_item", title: "Decoy" }] }),
    sha256Text,
  );
  const chosenSource = await writeDocument(chosenRoot, chosenDocument);
  await writeDocument(decoyRoot, decoyDocument);
  await writeFile(join(chosenRoot, "decoy.json"), encodeLocalDocument(decoyDocument));

  const request: { rootPath: string; fileBasename: string } = {
    rootPath: chosenRoot,
    fileBasename: "workgraph.json",
  };
  const inspection = store.inspectLocalDocument(request);

  request.rootPath = decoyRoot;
  request.fileBasename = "decoy.json";
  Reflect.set(request, "policyBasename", "decoy.json");

  const inspected = await Effect.runPromise(inspection);
  const expectedDigest = `sha256:${createHash("sha256").update(chosenSource, "utf8").digest("hex")}`;
  assert.equal(inspected.fileBasename, "workgraph.json");
  assert.equal(inspected.fileObservation.contentDigest, expectedDigest);
  assert.equal(inspected.identity.graphDigest, chosenDocument.graphDigest);
  assert.equal(inspected.policyFile, undefined);

  delete (request as { rootPath?: string }).rootPath;
  const rerun = await Effect.runPromise(inspection);
  assert.equal(rerun.fileObservation.contentDigest, expectedDigest);
  assert.equal(rerun.identity.graphDigest, chosenDocument.graphDigest);
});

test("inspection rejects incoherent documents and policy-invalid graphs", async () => {
  const incoherentRoot = join(fixtureRoot, "incoherent");
  await mkdir(incoherentRoot);
  const coherent = createGenesisDocument(graph(), sha256Text);
  await writeDocument(incoherentRoot, {
    ...coherent,
    graphDigest: `sha256:${"0".repeat(64)}`,
  });
  const incoherent = await inspectResult({
    rootPath: incoherentRoot,
    fileBasename: "workgraph.json",
  });
  assert.equal(Result.isFailure(incoherent), true);
  if (Result.isFailure(incoherent)) {
    assert.equal(incoherent.failure.code, "document_coherence_rejected");
  }

  const invalidGraphRoot = join(fixtureRoot, "invalid-graph");
  await mkdir(invalidGraphRoot);
  await writeDocument(
    invalidGraphRoot,
    createGenesisDocument(
      graph({
        nodes: [
          { id: "work:duplicate", kind: "work_item", title: "One" },
          { id: "work:duplicate", kind: "work_item", title: "Two" },
        ],
      }),
      sha256Text,
    ),
  );
  const invalidGraph = await inspectResult({
    rootPath: invalidGraphRoot,
    fileBasename: "workgraph.json",
  });
  assert.equal(Result.isFailure(invalidGraph), true);
  if (Result.isFailure(invalidGraph)) {
    assert.equal(invalidGraph.failure.code, "graph_validation_rejected");
  }
});

test("inspection rejects malformed and conflicting optional policy inputs", async () => {
  const rootPath = join(fixtureRoot, "invalid-policies");
  await mkdir(rootPath);
  await writeDocument(rootPath, createGenesisDocument(graph(), sha256Text));
  await writeFile(join(rootPath, "malformed.json"), "{");
  const malformed = await inspectResult({
    rootPath,
    fileBasename: "workgraph.json",
    policyBasename: "malformed.json",
  });
  assert.equal(Result.isFailure(malformed), true);
  if (Result.isFailure(malformed)) assert.equal(malformed.failure.code, "policy_decode_failed");

  await writeFile(
    join(rootPath, "duplicate.json"),
    JSON.stringify({
      schemaVersion: "workgraph.policy-definitions/v1alpha1",
      definitions: [
        {
          id: "workgraph.policy.administrative",
          version: "1",
          authority: "administrative_assertion",
          evidenceCategory: "agent_assertion",
          rules: [],
        },
      ],
    }),
  );
  const duplicate = await inspectResult({
    rootPath,
    fileBasename: "workgraph.json",
    policyBasename: "duplicate.json",
  });
  assert.equal(Result.isFailure(duplicate), true);
  if (Result.isFailure(duplicate)) {
    assert.equal(duplicate.failure.code, "policy_registry_rejected");
  }
});
