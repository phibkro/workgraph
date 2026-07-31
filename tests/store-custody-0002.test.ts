import assert from "node:assert/strict";
import { link, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Effect, Result } from "effect";
import {
  decodeSafeBasename,
  makeLocalFileStore,
  type ExclusiveFenceLockApi,
  type LocalFileStoreApi,
  type StoreReadFailure,
} from "../src/local/store.ts";

const fixtureRoot = join(tmpdir(), `workgraph-store-custody-${process.pid}-${crypto.randomUUID()}`);

let store: LocalFileStoreApi;

const runtimeFence = async (): Promise<ExclusiveFenceLockApi> => {
  if (typeof Bun !== "undefined") {
    return (await import("../src/local/bun-file-store.ts")).makeBunExclusiveFenceLock();
  }
  return (await import("../src/local/node-file-store.ts")).makeNodeExclusiveFenceLock();
};

const resultOf = <A>(effect: Effect.Effect<A, StoreReadFailure>) =>
  Effect.runPromise(Effect.result(effect));

before(async () => {
  await mkdir(fixtureRoot, { recursive: false });
  store = makeLocalFileStore(await runtimeFence());
});

after(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(fixtureRoot, { recursive: true, force: true });
});

test("safe basename decoder rejects traversal and ambiguous child names", () => {
  for (const value of ["", ".", "..", "../graph.json", "/graph.json", "a\\b", "a\0b"]) {
    assert.deepEqual(decodeSafeBasename(value), {
      ok: false,
      code: "unsafe_basename",
      detail: "A file name must be one safe direct-child basename of 1 through 255 UTF-8 bytes.",
    });
  }
  assert.equal(decodeSafeBasename("graph.json").ok, true);
  assert.equal(decodeSafeBasename("a".repeat(255)).ok, true);
  assert.equal(decodeSafeBasename("a".repeat(256)).ok, false);
  assert.equal(decodeSafeBasename("é".repeat(128)).ok, false);
});

test("retained-root reads reject symbolic links and multiply-linked files", async () => {
  const root = join(fixtureRoot, "links");
  await mkdir(root);
  await writeFile(join(root, "source.json"), "{}");
  await symlink("source.json", join(root, "symbolic.json"));
  await link(join(root, "source.json"), join(root, "second-link.json"));

  const symbolic = await resultOf(
    store.observeRegularFile({ rootPath: root, basename: "symbolic.json" }),
  );
  assert.equal(Result.isFailure(symbolic), true);
  if (Result.isFailure(symbolic)) {
    assert.equal(Reflect.get(symbolic.failure, "_tag"), "Rejected");
    assert.equal(symbolic.failure.code, "child_not_regular");
  }

  const multiplyLinked = await resultOf(
    store.observeRegularFile({ rootPath: root, basename: "source.json" }),
  );
  assert.equal(Result.isFailure(multiplyLinked), true);
  if (Result.isFailure(multiplyLinked)) {
    assert.equal(Reflect.get(multiplyLinked.failure, "_tag"), "Rejected");
    assert.equal(multiplyLinked.failure.code, "child_link_count_invalid");
  }
});

test("retained root contains a read after the original ancestor is replaced", async () => {
  const original = join(fixtureRoot, "original");
  const moved = join(fixtureRoot, "moved");
  await mkdir(original);
  await writeFile(join(original, "graph.json"), "retained");

  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* store.openRoot(original);
        yield* Effect.promise(async () => {
          await rename(original, moved);
          await mkdir(original);
          await writeFile(join(original, "graph.json"), "replacement");
        });
        const basename = decodeSafeBasename("graph.json");
        assert.equal(basename.ok, true);
        if (!basename.ok) throw new Error("safe basename rejected");
        return yield* root.readRegularFile(basename.basename);
      }),
    ),
  );

  assert.equal(new TextDecoder().decode(observed.bytes), "retained");
  assert.equal(observed.observation.linkCount, 1);
});

test("an unavailable native bridge fails before a child input read", async () => {
  const root = join(fixtureRoot, "unavailable");
  await mkdir(root);
  await writeFile(join(root, "graph.json"), "must-not-be-read");
  const unavailableStore = makeLocalFileStore({
    probe: () => Effect.succeed({ _tag: "Unavailable", detail: "injected unavailable bridge" }),
    tryAcquire: () => Effect.succeed({ _tag: "Unavailable" }),
    release: () => Effect.succeed(false),
  });
  const outcome = await Effect.runPromise(
    Effect.result(unavailableStore.observeRegularFile({ rootPath: root, basename: "graph.json" })),
  );
  assert.equal(Result.isFailure(outcome), true);
  if (Result.isFailure(outcome)) {
    assert.deepEqual(outcome.failure, {
      _tag: "Unavailable",
      phase: "root-open",
      code: "exclusive_fence_lock_unavailable",
      targetChangeKnowledge: { _tag: "NotObserved" },
      cleanupResidue: [],
    });
  }
});

test("an unavailable procfs capability fails before a child input read", async () => {
  const root = join(fixtureRoot, "procfs-unavailable");
  await mkdir(root);
  await writeFile(join(root, "graph.json"), "must-not-be-read");
  const unavailableStore = makeLocalFileStore(await runtimeFence(), {
    procSelfFdPath: join(fixtureRoot, "missing-proc-self-fd"),
  });
  const outcome = await Effect.runPromise(
    Effect.result(unavailableStore.observeRegularFile({ rootPath: root, basename: "graph.json" })),
  );
  assert.equal(Result.isFailure(outcome), true);
  if (Result.isFailure(outcome)) {
    assert.deepEqual(outcome.failure, {
      _tag: "Unavailable",
      phase: "root-open",
      code: "handle_relative_paths_unavailable",
      targetChangeKnowledge: { _tag: "NotObserved" },
      cleanupResidue: [],
    });
  }
});
