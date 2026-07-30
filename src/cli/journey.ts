import { Context, Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { deriveRoadmap } from "../core/derive.ts";
import { validateGraph } from "../core/graph.ts";
import { normalizeGraph, stableStringify } from "../core/normalize.ts";
import { PROJECTION_GENERATOR, projectAll } from "../core/projections.ts";
import type { ProjectionFile } from "../core/projections.ts";
import { evidenceManifest } from "../acceptance/manifest.ts";
import { tracerFixture } from "../fixture/tracer-0001.ts";

/**
 * Digest capability. The portable core never computes digests; composition
 * roots inject an implementation (WebCrypto in both the Bun and Node layers).
 */
export class Sha256 extends Context.Service<
  Sha256,
  { readonly hex: (data: string) => Effect.Effect<string> }
>()("workgraph/Sha256") {}

export const webCryptoSha256: Layer.Layer<Sha256> = Layer.succeed(Sha256, {
  hex: (data: string) =>
    Effect.promise(async () => {
      const bytes = new TextEncoder().encode(data);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }),
});

export class JourneyFailure extends Error {
  readonly _tag = "JourneyFailure";
  readonly code: string;
  readonly details: ReadonlyArray<string>;

  // Node's type-stripping mode requires erasable-only syntax, so no
  // constructor parameter properties anywhere on the Node execution path.
  constructor(code: string, details: ReadonlyArray<string>) {
    super(`${code}: ${details.join("; ")}`);
    this.code = code;
    this.details = details;
  }
}

export interface BuiltViews {
  readonly canonicalDigest: string;
  readonly files: ReadonlyArray<ProjectionFile>;
}

/** Deterministically build every generated view from the committed fixture. */
export const buildViews: Effect.Effect<BuiltViews, JourneyFailure, Sha256> = Effect.gen(
  function* () {
    const sha = yield* Sha256;
    const normalized = normalizeGraph(tracerFixture);

    const validation = validateGraph(normalized);
    if (!validation.accepted) {
      return yield* Effect.fail(
        new JourneyFailure(
          "fixture_rejected",
          validation.issues.map((issue) => `${issue.code}(${issue.subject})`),
        ),
      );
    }

    const canonicalJson = stableStringify(normalized);
    const canonicalDigest = yield* sha.hex(canonicalJson);
    const derivation = deriveRoadmap(normalized);
    const outcome = projectAll(normalized, derivation, canonicalDigest);
    if (!outcome.ok) {
      return yield* Effect.fail(
        new JourneyFailure("projection_failed", [outcome.failure.code, outcome.failure.detail]),
      );
    }

    const files: Array<ProjectionFile> = [
      ...outcome.files,
      {
        path: "acceptance-evidence.json",
        content: stableStringify(evidenceManifest(canonicalDigest)),
      },
    ];

    const hashes: Array<{ path: string; sha256: string }> = [];
    for (const file of files) {
      hashes.push({ path: file.path, sha256: yield* sha.hex(file.content) });
    }
    files.push({
      path: "drift-manifest.json",
      content: stableStringify({
        canonicalDigest: `sha256:${canonicalDigest}`,
        generator: PROJECTION_GENERATOR,
        note: "Derived views bound to the canonical digest. Regenerate and compare; never edit by hand.",
        files: hashes,
      }),
    });

    return { canonicalDigest, files };
  },
);

const writeViews = (outDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const built = yield* buildViews;
    yield* fs.makeDirectory(outDir, { recursive: true });
    for (const file of built.files) {
      yield* fs.writeFileString(`${outDir}/${file.path}`, file.content);
    }
    return built;
  });

const checkViews = (outDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const built = yield* buildViews;
    const drift: Array<string> = [];

    const expectedPaths = new Set(built.files.map((file) => file.path));
    const actualPaths = yield* fs
      .readDirectory(outDir)
      .pipe(Effect.mapError(() => new JourneyFailure("missing_generated_dir", [outDir])));
    for (const path of actualPaths) {
      if (!expectedPaths.has(path)) drift.push(`unexpected file ${outDir}/${path}`);
    }

    for (const file of built.files) {
      const committed = yield* fs
        .readFileString(`${outDir}/${file.path}`)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (committed === undefined) {
        drift.push(`missing file ${outDir}/${file.path}`);
        continue;
      }
      if (committed !== file.content) {
        drift.push(`drift in ${outDir}/${file.path}: content differs from regeneration`);
      }
    }

    if (drift.length > 0) {
      return yield* Effect.fail(new JourneyFailure("generated_view_drift", drift));
    }
    return built;
  });

export const runCli = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const mode = argv[0];
    const outFlag = argv.indexOf("--out");
    const outDir = outFlag >= 0 ? (argv[outFlag + 1] ?? "generated") : "generated";

    if (mode === "generate") {
      const built = yield* writeViews(outDir);
      return `generated ${built.files.length} views in ${outDir} from canonical digest sha256:${built.canonicalDigest}`;
    }
    if (mode === "check") {
      const built = yield* checkViews(outDir);
      return `verified ${built.files.length} views in ${outDir} against canonical digest sha256:${built.canonicalDigest}`;
    }
    return yield* Effect.fail(
      new JourneyFailure("usage", ["expected: generate|check [--out <dir>]"]),
    );
  });
