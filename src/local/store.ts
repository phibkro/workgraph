import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { Context, Effect, Layer, Result, type Scope } from "effect";
import { immutableSnapshot } from "../core/normalize.ts";
import type { Sha256Digest } from "../core/local-command.ts";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const PROC_SELF_FD = "/proc/self/fd";

declare const safeBasenameBrand: unique symbol;
export type SafeBasename = string & { readonly [safeBasenameBrand]: true };

export type SafeBasenameResult =
  | { readonly ok: true; readonly basename: SafeBasename }
  | { readonly ok: false; readonly code: "unsafe_basename"; readonly detail: string };

export const decodeSafeBasename = (value: string): SafeBasenameResult => {
  const bytes = Buffer.byteLength(value, "utf8");
  if (
    bytes < 1 ||
    bytes > 255 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return {
      ok: false,
      code: "unsafe_basename",
      detail: "A file name must be one safe direct-child basename of 1 through 255 UTF-8 bytes.",
    };
  }
  return { ok: true, basename: value as SafeBasename };
};

export interface RootIdentity {
  readonly device: number;
  readonly inode: number;
}

export interface ExactFileObservation {
  readonly _tag: "Exact";
  readonly device: number;
  readonly inode: number;
  readonly linkCount: number;
  readonly contentDigest: Sha256Digest;
}

export type FileObservation =
  | { readonly _tag: "Absent" }
  | ExactFileObservation
  | { readonly _tag: "Other"; readonly device: number; readonly inode: number }
  | { readonly _tag: "NotObserved" };

export interface ObservedRegularFile {
  readonly basename: SafeBasename;
  readonly byteLength: number;
  readonly copyBytes: () => Uint8Array;
  readonly mode: number;
  readonly observation: ExactFileObservation;
}

export interface ObserveRegularFileInput {
  readonly rootPath: string;
  readonly basename: string;
}

export interface StoreUnavailable {
  readonly _tag: "Unavailable";
  readonly phase: "platform-check" | "root-open";
  readonly code:
    | "unsupported_platform"
    | "handle_relative_paths_unavailable"
    | "exclusive_fence_lock_unavailable";
  readonly targetChangeKnowledge: { readonly _tag: "NotObserved" };
  readonly cleanupResidue: readonly [];
}

export interface StoreInputRejected {
  readonly _tag: "Rejected";
  readonly phase: "input-read";
  readonly code:
    | "unsafe_basename"
    | "child_not_regular"
    | "child_link_count_invalid"
    | "input_too_large"
    | "file_identity_changed"
    | "file_identity_out_of_range";
  readonly detail: string;
}

export interface StoreReadFailed {
  readonly _tag: "StoreFailed";
  readonly phase: "root-open" | "input-read";
  readonly code: string;
  readonly targetChangeKnowledge: { readonly _tag: "NotObserved" };
  readonly cleanupResidue: readonly [];
}

export type StoreOpenFailure = StoreUnavailable | StoreReadFailed;
export type StoreReadFailure = StoreUnavailable | StoreInputRejected | StoreReadFailed;

export type FenceProbeResult =
  | { readonly _tag: "Available" }
  | { readonly _tag: "Unavailable"; readonly detail: string };

export interface ExclusiveFenceLockApi {
  readonly probe: (fd: number) => Effect.Effect<FenceProbeResult>;
  readonly tryAcquire: (
    fd: number,
  ) => Effect.Effect<
    { readonly _tag: "Acquired" } | { readonly _tag: "Busy" } | { readonly _tag: "Unavailable" }
  >;
  readonly release: (fd: number) => Effect.Effect<boolean>;
}

export class ExclusiveFenceLock extends Context.Service<
  ExclusiveFenceLock,
  ExclusiveFenceLockApi
>()("workgraph/ExclusiveFenceLock") {}

export interface RetainedRoot {
  readonly identity: RootIdentity;
  readonly readRegularFile: (
    basename: string,
  ) => Effect.Effect<ObservedRegularFile, StoreReadFailure>;
}

export interface LocalFileStoreApi {
  readonly openRoot: (
    rootPath: string,
  ) => Effect.Effect<RetainedRoot, StoreOpenFailure, Scope.Scope>;
  readonly observeRegularFile: (
    input: ObserveRegularFileInput,
  ) => Effect.Effect<ObservedRegularFile, StoreReadFailure>;
}

export class LocalFileStore extends Context.Service<LocalFileStore, LocalFileStoreApi>()(
  "workgraph/LocalFileStore",
) {}

interface BigIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

const unavailable = (
  phase: StoreUnavailable["phase"],
  code: StoreUnavailable["code"],
): StoreUnavailable =>
  immutableSnapshot({
    _tag: "Unavailable",
    phase,
    code,
    targetChangeKnowledge: { _tag: "NotObserved" },
    cleanupResidue: [],
  });

const failed = (phase: StoreReadFailed["phase"], code: string): StoreReadFailed =>
  immutableSnapshot({
    _tag: "StoreFailed",
    phase,
    code,
    targetChangeKnowledge: { _tag: "NotObserved" },
    cleanupResidue: [],
  });

const rejected = (code: StoreInputRejected["code"], detail: string): StoreInputRejected =>
  immutableSnapshot({ _tag: "Rejected", phase: "input-read", code, detail });

const safeNumber = (value: bigint): number | undefined => {
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : undefined;
};

const sameBigIdentity = (
  left: BigIdentity & {
    readonly size: bigint;
    readonly links: bigint;
    readonly mode: bigint;
    readonly modifiedNanoseconds: bigint;
    readonly changedNanoseconds: bigint;
  },
  right: BigIdentity & {
    readonly size: bigint;
    readonly links: bigint;
    readonly mode: bigint;
    readonly modifiedNanoseconds: bigint;
    readonly changedNanoseconds: bigint;
  },
): boolean =>
  left.device === right.device &&
  left.inode === right.inode &&
  left.size === right.size &&
  left.links === right.links &&
  left.mode === right.mode &&
  left.modifiedNanoseconds === right.modifiedNanoseconds &&
  left.changedNanoseconds === right.changedNanoseconds;

const fileIdentity = (metadata: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly nlink: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}) => ({
  device: metadata.dev,
  inode: metadata.ino,
  size: metadata.size,
  links: metadata.nlink,
  mode: metadata.mode,
  modifiedNanoseconds: metadata.mtimeNs,
  changedNanoseconds: metadata.ctimeNs,
});

const sha256Bytes = (bytes: Uint8Array): Sha256Digest =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * This checkpoint only reads already-open files and publishes no filesystem
 * state. A close failure cannot change the captured bytes, metadata, or digest,
 * and the observation makes no claim that descriptor cleanup succeeded.
 * Mutation scopes must replace this helper with typed cleanup evidence.
 */
const closeQuietly = (handle: FileHandle): Effect.Effect<void> =>
  Effect.promise(async () => {
    try {
      await handle.close();
    } catch {
      // No filesystem effect or cleanup-success claim belongs to this read observation.
    }
  });

type HandleRelativePathsProbe = (
  fd: number,
  identity: BigIdentity,
) => Effect.Effect<void, StoreUnavailable>;

const fixedHandleRelativePathsProbe: HandleRelativePathsProbe = (fd, identity) =>
  Effect.tryPromise({
    try: async () => {
      const visible = await stat(`${PROC_SELF_FD}/${fd}`, { bigint: true });
      if (visible.dev !== identity.device || visible.ino !== identity.inode) {
        throw new Error("retained root is not visible through the fixed procfs route");
      }
    },
    catch: () => unavailable("root-open", "handle_relative_paths_unavailable"),
  });

const unavailableHandleRelativePathsProbe: HandleRelativePathsProbe = () =>
  Effect.fail(unavailable("root-open", "handle_relative_paths_unavailable"));

const openRetainedRoot = (
  rootPath: string,
  fence: ExclusiveFenceLockApi,
  probeHandleRelativePaths: HandleRelativePathsProbe,
): Effect.Effect<RetainedRoot, StoreOpenFailure, Scope.Scope> =>
  Effect.gen(function* () {
    if (process.platform !== "linux") {
      return yield* Effect.fail(unavailable("platform-check", "unsupported_platform"));
    }

    const handle = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          open(rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
        catch: () => failed("root-open", "root_open_failed"),
      }),
      closeQuietly,
    );
    const initial = yield* Effect.tryPromise({
      try: () => handle.stat({ bigint: true }),
      catch: () => failed("root-open", "root_fstat_failed"),
    });
    if (!initial.isDirectory()) {
      return yield* Effect.fail(failed("root-open", "root_not_directory"));
    }
    const rootIdentity = { device: initial.dev, inode: initial.ino };
    const assertRoot = (phase: StoreReadFailed["phase"]): Effect.Effect<void, StoreReadFailed> =>
      Effect.tryPromise({
        try: async () => {
          const current = await handle.stat({ bigint: true });
          if (current.dev !== rootIdentity.device || current.ino !== rootIdentity.inode) {
            throw new Error("retained root identity changed");
          }
        },
        catch: () => failed(phase, "retained_root_identity_changed"),
      });

    const withRootRecheck = <A, E>(
      effect: Effect.Effect<A, E>,
      phase: StoreReadFailed["phase"],
    ): Effect.Effect<A, E | StoreReadFailed> =>
      Effect.gen(function* () {
        const result = yield* Effect.result(effect);
        yield* assertRoot(phase);
        if (Result.isFailure(result)) return yield* Effect.fail(result.failure);
        return result.success;
      });

    yield* withRootRecheck(probeHandleRelativePaths(handle.fd, rootIdentity), "root-open");
    const probe = yield* withRootRecheck(fence.probe(handle.fd), "root-open");
    if (Reflect.get(probe, "_tag") !== "Available") {
      return yield* Effect.fail(unavailable("root-open", "exclusive_fence_lock_unavailable"));
    }

    const readRegularFile = (
      basename: string,
    ): Effect.Effect<ObservedRegularFile, StoreReadFailure> =>
      Effect.scoped(
        Effect.gen(function* () {
          const decoded = decodeSafeBasename(basename);
          if (!decoded.ok) {
            return yield* Effect.fail(rejected(decoded.code, decoded.detail));
          }
          const safeBasename = decoded.basename;
          yield* assertRoot("input-read");
          const childPath = `${PROC_SELF_FD}/${handle.fd}/${safeBasename}`;
          const child = yield* Effect.acquireRelease(
            withRootRecheck(
              Effect.tryPromise({
                try: () =>
                  open(childPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
                catch: (error) => {
                  const code =
                    typeof error === "object" && error !== null && "code" in error
                      ? String(error.code)
                      : "unknown";
                  return code === "ELOOP"
                    ? rejected("child_not_regular", "Symbolic-link children are not accepted.")
                    : failed("input-read", `child_open_failed:${code}`);
                },
              }),
              "input-read",
            ),
            closeQuietly,
          );
          const before = yield* withRootRecheck(
            Effect.tryPromise({
              try: () => child.stat({ bigint: true }),
              catch: () => failed("input-read", "child_fstat_failed"),
            }),
            "input-read",
          );
          if (!before.isFile()) {
            return yield* Effect.fail(
              rejected("child_not_regular", "The input must be a regular file."),
            );
          }
          if (before.nlink !== 1n) {
            return yield* Effect.fail(
              rejected("child_link_count_invalid", "The input file must have exactly one link."),
            );
          }
          if (before.size > BigInt(MAX_INPUT_BYTES)) {
            return yield* Effect.fail(
              rejected("input_too_large", "The input file exceeds the 8 MiB byte limit."),
            );
          }
          const buffer = Buffer.allocUnsafe(MAX_INPUT_BYTES + 1);
          const readResult = yield* withRootRecheck(
            Effect.tryPromise({
              try: () => child.read(buffer, 0, buffer.byteLength, 0),
              catch: () => failed("input-read", "child_read_failed"),
            }),
            "input-read",
          );
          if (readResult.bytesRead > MAX_INPUT_BYTES) {
            return yield* Effect.fail(
              rejected("input_too_large", "The input file exceeds the 8 MiB byte limit."),
            );
          }
          const after = yield* withRootRecheck(
            Effect.tryPromise({
              try: () => child.stat({ bigint: true }),
              catch: () => failed("input-read", "child_final_fstat_failed"),
            }),
            "input-read",
          );
          if (!sameBigIdentity(fileIdentity(before), fileIdentity(after))) {
            return yield* Effect.fail(
              rejected("file_identity_changed", "The input file changed while it was read."),
            );
          }
          if (BigInt(readResult.bytesRead) !== after.size) {
            return yield* Effect.fail(
              rejected("file_identity_changed", "The input file changed while it was read."),
            );
          }
          const device = safeNumber(after.dev);
          const inode = safeNumber(after.ino);
          const linkCount = safeNumber(after.nlink);
          if (device === undefined || inode === undefined || linkCount === undefined) {
            return yield* Effect.fail(
              rejected("file_identity_out_of_range", "The file identity is not a safe integer."),
            );
          }
          const capturedBytes = new Uint8Array(buffer.subarray(0, readResult.bytesRead));
          return Object.freeze({
            basename: safeBasename,
            byteLength: capturedBytes.byteLength,
            copyBytes: () => new Uint8Array(capturedBytes),
            mode: Number(after.mode & 0o7777n),
            observation: immutableSnapshot({
              _tag: "Exact" as const,
              device,
              inode,
              linkCount,
              contentDigest: sha256Bytes(capturedBytes),
            }),
          });
        }),
      );

    const device = safeNumber(rootIdentity.device);
    const inode = safeNumber(rootIdentity.inode);
    if (device === undefined || inode === undefined) {
      return yield* Effect.fail(failed("root-open", "root_identity_out_of_range"));
    }
    return {
      identity: immutableSnapshot({ device, inode }),
      readRegularFile,
    };
  });

const makeLocalFileStoreWithProbe = (
  fence: ExclusiveFenceLockApi,
  probeHandleRelativePaths: HandleRelativePathsProbe,
): LocalFileStoreApi => {
  const openRoot = (rootPath: string) =>
    openRetainedRoot(rootPath, fence, probeHandleRelativePaths);
  return {
    openRoot,
    observeRegularFile: (input) => {
      const decoded = decodeSafeBasename(input.basename);
      if (!decoded.ok) {
        return Effect.fail(rejected(decoded.code, decoded.detail));
      }
      return Effect.scoped(
        Effect.flatMap(openRoot(input.rootPath), (root) => root.readRegularFile(decoded.basename)),
      );
    },
  };
};

export const makeLocalFileStore = (fence: ExclusiveFenceLockApi): LocalFileStoreApi =>
  makeLocalFileStoreWithProbe(fence, fixedHandleRelativePathsProbe);

/**
 * Failure-only test seam. It cannot provide a substitute route and is not used
 * by either live layer.
 */
export const makeHandleRelativePathsUnavailableStoreForTest = (
  fence: ExclusiveFenceLockApi,
): LocalFileStoreApi => makeLocalFileStoreWithProbe(fence, unavailableHandleRelativePathsProbe);

export const makeLocalFileStoreLayer = (
  fenceLayer: Layer.Layer<ExclusiveFenceLock>,
): Layer.Layer<LocalFileStore> =>
  Layer.effect(
    LocalFileStore,
    Effect.map(ExclusiveFenceLock, (fence) => makeLocalFileStore(fence)),
  ).pipe(Layer.provide(fenceLayer));
