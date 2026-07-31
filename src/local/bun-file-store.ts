import { dlopen, FFIType, read, type Pointer } from "bun:ffi";
import { Effect, Layer } from "effect";
import {
  ExclusiveFenceLock,
  type ExclusiveFenceLockApi,
  makeLocalFileStoreLayer,
} from "./store.ts";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EAGAIN = 11;

type BunFlockBridge = {
  readonly flock: (fd: number, operation: number) => number;
  readonly errnoLocation: () => Pointer | null;
};

const loadBridge = (): BunFlockBridge | undefined => {
  try {
    const library = dlopen("libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      __errno_location: { args: [], returns: FFIType.ptr },
    });
    return {
      flock: library.symbols.flock,
      // oxlint-disable-next-line no-underscore-dangle -- This is the exact glibc ABI symbol.
      errnoLocation: library.symbols.__errno_location,
    };
  } catch {
    return undefined;
  }
};

export const makeBunExclusiveFenceLock = (
  load: () => BunFlockBridge | undefined = loadBridge,
): ExclusiveFenceLockApi => {
  const bridge = load();
  const acquire = (fd: number) => {
    if (bridge === undefined) return { _tag: "Unavailable" } as const;
    if (bridge.flock(fd, LOCK_EX | LOCK_NB) === 0) return { _tag: "Acquired" } as const;
    const errnoPointer = bridge.errnoLocation();
    return errnoPointer !== null && read.i32(errnoPointer) === EAGAIN
      ? ({ _tag: "Busy" } as const)
      : ({ _tag: "Unavailable" } as const);
  };
  return {
    probe: (fd) =>
      Effect.sync(() => {
        const result = acquire(fd);
        const tag = Reflect.get(result, "_tag");
        if (tag === "Busy") return { _tag: "Available" } as const;
        if (tag === "Unavailable") {
          return {
            _tag: "Unavailable",
            detail: `Bun libc flock probe returned ${String(tag)}.`,
          } as const;
        }
        return bridge?.flock(fd, LOCK_UN) === 0
          ? ({ _tag: "Available" } as const)
          : ({ _tag: "Unavailable", detail: "Bun libc flock unlock failed." } as const);
      }),
    tryAcquire: (fd) => Effect.sync(() => acquire(fd)),
    release: (fd) => Effect.sync(() => bridge !== undefined && bridge.flock(fd, LOCK_UN) === 0),
  };
};

export const bunExclusiveFenceLockLayer = Layer.succeed(
  ExclusiveFenceLock,
  makeBunExclusiveFenceLock(),
);

export const bunLocalFileStoreLayer = makeLocalFileStoreLayer(bunExclusiveFenceLockLayer);
