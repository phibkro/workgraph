/**
 * Executable acceptance hook for design spec 0002.
 *
 * The hook runs the canonical full gate before the focused tracer suite.
 * The focused suite is an implementation deliverable, so this frozen
 * contract fails with one missing-implementation result until it exists.
 */
import { stat } from "node:fs/promises";
import { Console, Effect } from "effect";

const projectRoot = import.meta.dir.endsWith("/scripts")
  ? import.meta.dir.slice(0, -"/scripts".length)
  : import.meta.dir;

class AcceptFailure extends Error {
  readonly _tag = "AcceptFailure";

  constructor(
    readonly section: string,
    readonly detail: string,
  ) {
    super(`${section}: ${detail}`);
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

const requiredImplementation = [
  "src/core/policy-registry.ts",
  "src/core/local-command.ts",
  "src/fixture/policy-registry-0001.ts",
  "src/local/document-codec.ts",
  "src/local/store.ts",
  "src/local/bun-file-store.ts",
  "src/local/node-file-store.ts",
  "src/cli/local-command.ts",
  "tests/acceptance-0002.test.ts",
  "docs/local-command-loop.md",
  "skills/workgraph-local/SKILL.md",
] as const;

const requireImplementation = Effect.gen(function* () {
  const missing = yield* Effect.promise(async () => {
    const observations = await Promise.all(
      requiredImplementation.map(async (path) => {
        try {
          const metadata = await stat(`${projectRoot}/${path}`);
          return metadata.isFile() ? undefined : path;
        } catch {
          return path;
        }
      }),
    );
    return observations.filter((path) => path !== undefined);
  });

  if (missing.length > 0) {
    return yield* Effect.fail(
      new AcceptFailure(
        "missing-implementation",
        `design 0002 is frozen but not implemented; missing: ${missing.join(", ")}`,
      ),
    );
  }
});

const requireRealNode = Effect.gen(function* () {
  const node = Bun.which("node");
  if (node === null) {
    return yield* Effect.fail(
      new AcceptFailure("toolchain", "required tool 'node' is not on PATH"),
    );
  }
  const observation = yield* Effect.promise(async () => {
    const child = Bun.spawn(
      [
        node,
        "-e",
        "process.stdout.write(typeof Bun === 'undefined' ? process.version : 'bun-shim')",
      ],
      { cwd: projectRoot, stdout: "pipe", stderr: "inherit" },
    );
    const output = (await new Response(child.stdout).text()).trim();
    return { output, exitCode: await child.exited };
  });
  if (
    observation.exitCode !== 0 ||
    observation.output === "bun-shim" ||
    !observation.output.startsWith("v")
  ) {
    return yield* Effect.fail(
      new AcceptFailure(
        "toolchain",
        `'node' is not a genuine Node.js runtime (observation: '${observation.output}')`,
      ),
    );
  }
  yield* Console.log(`→ [toolchain] genuine Node.js ${observation.output}`);
});

const program = Effect.gen(function* () {
  yield* run("canonical-full-gate", ["bun", "run", "check"]);
  yield* requireImplementation;
  yield* requireRealNode;
  yield* run("focused-acceptance", ["bun", "test", "tests/acceptance-0002.test.ts"]);
  yield* Console.log(
    "accept:0002 completed in this process. The caller owns exact source, environment, output, and observation-time binding.",
  );
});

Effect.runPromise(program).catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
