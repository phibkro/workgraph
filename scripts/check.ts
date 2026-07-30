import { Console, Effect } from "effect";

class CheckFailure extends Error {
  readonly _tag = "CheckFailure";

  constructor(
    readonly command: ReadonlyArray<string>,
    readonly exitCode: number,
  ) {
    super(`Command failed (${exitCode}): ${command.join(" ")}`);
  }
}

const run = (command: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* Console.log(`→ ${command.join(" ")}`);
    const exitCode = yield* Effect.promise(async () => {
      const process = Bun.spawn([...command], {
        cwd: import.meta.dir.endsWith("/scripts")
          ? import.meta.dir.slice(0, -"/scripts".length)
          : import.meta.dir,
        stdout: "inherit",
        stderr: "inherit",
      });
      return await process.exited;
    });
    if (exitCode !== 0) return yield* Effect.fail(new CheckFailure(command, exitCode));
  });

const program = Effect.gen(function* () {
  yield* run(["bun", "run", "format:check"]);
  yield* run(["bun", "run", "lint"]);
  yield* run(["bun", "run", "typecheck"]);
  yield* run(["bun", "run", "check:imports"]);
  yield* run(["bun", "test"]);
});

Effect.runPromise(program).catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
