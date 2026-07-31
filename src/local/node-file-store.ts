import { Effect, Layer } from "effect";
import { createRequire } from "node:module";
import {
  ExclusiveFenceLock,
  type ExclusiveFenceLockApi,
  makeLocalFileStoreLayer,
} from "./store.ts";

interface NodeFlockModule {
  readonly flockSync: (fd: number, operation: "exnb" | "un") => void;
}

const require = createRequire(import.meta.url);

const loadBridge = (): NodeFlockModule | undefined => {
  try {
    return require("fs-ext-extra-prebuilt") as NodeFlockModule;
  } catch {
    return undefined;
  }
};

export const makeNodeExclusiveFenceLock = (
  load: () => NodeFlockModule | undefined = loadBridge,
): ExclusiveFenceLockApi => {
  const bridge = load();
  const acquire = (fd: number) => {
    if (bridge === undefined) return { _tag: "Unavailable" } as const;
    try {
      bridge.flockSync(fd, "exnb");
      return { _tag: "Acquired" } as const;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "unknown";
      return code === "EAGAIN" || code === "EWOULDBLOCK"
        ? ({ _tag: "Busy" } as const)
        : ({ _tag: "Unavailable" } as const);
    }
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
            detail: `Node native flock probe returned ${String(tag)}.`,
          } as const;
        }
        try {
          bridge?.flockSync(fd, "un");
          return { _tag: "Available" } as const;
        } catch {
          return { _tag: "Unavailable", detail: "Node native flock unlock failed." } as const;
        }
      }),
    tryAcquire: (fd) => Effect.sync(() => acquire(fd)),
    release: (fd) =>
      Effect.sync(() => {
        try {
          bridge?.flockSync(fd, "un");
          return bridge !== undefined;
        } catch {
          return false;
        }
      }),
  };
};

export const nodeExclusiveFenceLockLayer = Layer.succeed(
  ExclusiveFenceLock,
  makeNodeExclusiveFenceLock(),
);

export const nodeLocalFileStoreLayer = makeLocalFileStoreLayer(nodeExclusiveFenceLockLayer);
