/**
 * Executable acceptance gate for design spec 0001.
 *
 * Owns: the observable Bun/Node tracer journey, byte-equivalence comparison,
 * the generated-view drift check, the unsupported-claims scan, and the
 * acceptance-contract coverage map. The generated map is not run evidence.
 * A missing runtime or tool is a failure, never a warning.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Console, Effect } from "effect";
import { unsupportedClaimFindings } from "../src/acceptance/claims.ts";
import { ACCEPTANCE_TEST_FILE, acceptanceCoverage } from "../src/acceptance/manifest.ts";
import { stableStringify } from "../src/core/normalize.ts";

const projectRoot = import.meta.dir.endsWith("/scripts")
  ? import.meta.dir.slice(0, -"/scripts".length)
  : import.meta.dir;

class AcceptFailure extends Error {
  readonly _tag = "AcceptFailure";
  readonly section: string;

  constructor(section: string, detail: string) {
    super(`${section}: ${detail}`);
    this.section = section;
  }
}

const run = (section: string, command: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* Console.log(`→ [${section}] ${command.join(" ")}`);
    const exitCode = yield* Effect.promise(async () => {
      const child = Bun.spawn([...command], {
        cwd: projectRoot,
        stdout: "inherit",
        stderr: "inherit",
      });
      return await child.exited;
    });
    if (exitCode !== 0) {
      return yield* Effect.fail(
        new AcceptFailure(section, `command failed (${exitCode}): ${command.join(" ")}`),
      );
    }
  });

const requireTool = (tool: string) =>
  Effect.gen(function* () {
    const resolved = Bun.which(tool);
    if (resolved === null) {
      return yield* Effect.fail(
        new AcceptFailure(
          "toolchain",
          `required tool '${tool}' is not on PATH; a missing runtime is a failure, never a warning`,
        ),
      );
    }
    yield* Console.log(`→ [toolchain] ${tool}: ${resolved}`);
  });

/**
 * `bun run` prepends a `node` shim that is Bun itself, which would make the
 * Bun/Node parity comparison vacuous (Bun compared against Bun). The parity
 * gate therefore executes the resolved runtime and rejects anything that is
 * not a genuine Node.js.
 */
const requireRealNode = Effect.gen(function* () {
  yield* requireTool("node");
  const probe = yield* Effect.promise(async () => {
    const child = Bun.spawn(
      [
        "node",
        "-e",
        "process.stdout.write(typeof Bun === 'undefined' ? process.version : 'bun-shim')",
      ],
      { cwd: projectRoot, stdout: "pipe", stderr: "inherit" },
    );
    const output = await new Response(child.stdout).text();
    const exitCode = await child.exited;
    return { output: output.trim(), exitCode };
  });
  if (probe.exitCode !== 0 || probe.output === "bun-shim" || !probe.output.startsWith("v")) {
    return yield* Effect.fail(
      new AcceptFailure(
        "toolchain",
        `'node' on PATH is not a genuine Node.js runtime (probe: '${probe.output}'); Bun's node shim cannot establish Bun/Node parity`,
      ),
    );
  }
  yield* Console.log(`→ [toolchain] node is genuine Node.js ${probe.output}`);
});

const compareDirectories = (section: string, leftDir: string, rightDir: string) =>
  Effect.gen(function* () {
    const problems = yield* Effect.promise(async () => {
      const [leftFiles, rightFiles] = await Promise.all([readdir(leftDir), readdir(rightDir)]);
      const union = [...new Set([...leftFiles, ...rightFiles])].toSorted();
      const results = await Promise.all(
        union.map(async (name) => {
          if (!leftFiles.includes(name)) return [`${name}: missing from ${leftDir}`];
          if (!rightFiles.includes(name)) return [`${name}: missing from ${rightDir}`];
          const [left, right] = await Promise.all([
            readFile(join(leftDir, name)),
            readFile(join(rightDir, name)),
          ]);
          return left.equals(right) ? [] : [`${name}: byte content differs`];
        }),
      );
      return results.flat();
    });
    if (problems.length > 0) {
      return yield* Effect.fail(new AcceptFailure(section, problems.join("; ")));
    }
    yield* Console.log(`→ [${section}] directories are byte-equivalent`);
  });

const claimsScan = Effect.gen(function* () {
  const generatedDir = join(projectRoot, "generated");
  const problems = yield* Effect.promise(async () => {
    const files = (await readdir(generatedDir)).toSorted();
    const phraseFindings = await Promise.all(
      files.map(async (name) => {
        const content = await readFile(join(generatedDir, name), "utf8");
        return unsupportedClaimFindings(content).map(
          (claim) => `${name}: matches unsupported claim pattern '${claim}'`,
        );
      }),
    );
    const found: Array<string> = phraseFindings.flat();

    // Cross-file check against the canonical source, not the projection
    // against itself: every human-approval event in the normalized graph must
    // be labeled as a non-machine-checked human assertion in the explanation
    // view. Checking the projection's own derived fields against each other
    // would only re-confirm the projector.
    const canonical = JSON.parse(
      await readFile(join(generatedDir, "normalized-graph.json"), "utf8"),
    ) as {
      canonicalGraph: {
        events: ReadonlyArray<{ id: string; authority: string }>;
      };
    };
    const explanations = JSON.parse(
      await readFile(join(generatedDir, "transition-explanations.json"), "utf8"),
    ) as {
      events: ReadonlyArray<{
        id: string;
        evidenceCategory: string;
        machineChecked: boolean;
        humanApprovedAssertion: boolean;
      }>;
    };
    const explanationById = new Map(explanations.events.map((event) => [event.id, event]));
    for (const event of canonical.canonicalGraph.events) {
      if (event.authority !== "human_approval") continue;
      const explained = explanationById.get(event.id);
      if (
        explained === undefined ||
        explained.machineChecked !== false ||
        explained.evidenceCategory !== "human_approved_assertion" ||
        explained.humanApprovedAssertion !== true
      ) {
        found.push(
          `${event.id}: canonical human-approval event is not labeled as a non-machine-checked human assertion in the explanation view`,
        );
      }
    }
    return found;
  });
  if (problems.length > 0) {
    return yield* Effect.fail(new AcceptFailure("claims-scan", problems.join("; ")));
  }
  yield* Console.log("→ [claims-scan] no unsupported claim appears in any projection");
});

const digestBinding = Effect.gen(function* () {
  const generatedDir = join(projectRoot, "generated");
  const problems = yield* Effect.promise(async () => {
    const manifest = JSON.parse(
      await readFile(join(generatedDir, "drift-manifest.json"), "utf8"),
    ) as { canonicalDigest: string; files: ReadonlyArray<{ path: string; sha256: string }> };
    const names = (await readdir(generatedDir)).toSorted();
    const carryFindings = await Promise.all(
      names.map(async (name) => {
        const content = await readFile(join(generatedDir, name), "utf8");
        return content.includes(manifest.canonicalDigest)
          ? []
          : [`${name}: does not carry canonical digest ${manifest.canonicalDigest}`];
      }),
    );
    const found: Array<string> = carryFindings.flat();
    const hasher = new Bun.CryptoHasher("sha256");
    const normalizedProjection = JSON.parse(
      await readFile(join(generatedDir, "normalized-graph.json"), "utf8"),
    ) as { canonicalGraph: unknown };
    hasher.update(stableStringify(normalizedProjection.canonicalGraph));
    const recomputed = `sha256:${hasher.digest("hex")}`;
    if (recomputed !== manifest.canonicalDigest) {
      found.push(
        `drift-manifest canonical digest ${manifest.canonicalDigest} does not match normalized graph digest ${recomputed}`,
      );
    }
    return found;
  });
  if (problems.length > 0) {
    return yield* Effect.fail(new AcceptFailure("digest-binding", problems.join("; ")));
  }
  yield* Console.log("→ [digest-binding] every projection carries the same canonical digest");
});

const program = Effect.gen(function* () {
  yield* requireTool("bun");
  yield* requireRealNode;

  yield* run("acceptance-tests", ["bun", "test", ACCEPTANCE_TEST_FILE]);
  yield* run("portable-import-closure", ["bun", "scripts/check-portable-imports.ts"]);

  const scratch = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "workgraph-accept-0001-")));
  const bunOut = join(scratch, "bun-out");
  const nodeOut = join(scratch, "node-out");
  yield* Effect.gen(function* () {
    yield* run("bun-journey", ["bun", "src/cli/main-bun.ts", "generate", "--out", bunOut]);
    yield* run("node-journey", ["node", "src/cli/main-node.ts", "generate", "--out", nodeOut]);
    yield* compareDirectories("bun-node-parity", bunOut, nodeOut);
    yield* compareDirectories("drift-check", join(projectRoot, "generated"), bunOut);
  }).pipe(Effect.ensuring(Effect.promise(() => rm(scratch, { recursive: true, force: true }))));

  yield* run("drift-check", ["bun", "src/cli/main-bun.ts", "check", "--out", "generated"]);
  yield* digestBinding;
  yield* claimsScan;

  yield* Console.log("");
  yield* Console.log("Acceptance contract coverage (per design spec 0001):");
  for (const item of acceptanceCoverage) {
    yield* Console.log(`  item ${item.item}: exercised by ${item.exercisedBy.join(" AND ")}`);
  }
  yield* Console.log("");
  yield* Console.log(
    "accept:0001 completed in this process. Exact source/environment/result binding belongs to the external caller or CI observation; this output does not establish operational suitability or human intent.",
  );
});

Effect.runPromise(program).catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
