import { Effect, Result } from "effect";
import { stableStringify } from "../core/normalize.ts";
import { LocalFileStore, type LocalDocumentInspectionFailure } from "../local/store.ts";

export interface LocalCliExecution {
  readonly exitCode: number;
  readonly stdout: string;
}

interface InspectArguments {
  readonly rootPath: string;
  readonly fileBasename: string;
  readonly policyBasename?: string;
}

type ParseResult =
  | { readonly ok: true; readonly command: "inspect"; readonly arguments: InspectArguments }
  | { readonly ok: false; readonly detail: string };

const usage = "expected: inspect --root <dir> --file <basename> [--policies <basename>]";

const parseInspect = (argv: ReadonlyArray<string>): ParseResult => {
  if (argv[0] !== "inspect") return { ok: false, detail: usage };

  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !["--root", "--file", "--policies"].includes(flag) ||
      values.has(flag)
    ) {
      return { ok: false, detail: usage };
    }
    values.set(flag, value);
  }

  const rootPath = values.get("--root");
  const fileBasename = values.get("--file");
  const policyBasename = values.get("--policies");
  if (rootPath === undefined || fileBasename === undefined) {
    return { ok: false, detail: usage };
  }
  return {
    ok: true,
    command: "inspect",
    arguments: {
      rootPath,
      fileBasename,
      ...(policyBasename === undefined ? {} : { policyBasename }),
    },
  };
};

const exitCodeForFailure = (failure: LocalDocumentInspectionFailure): number => {
  switch (Reflect.get(failure, "_tag")) {
    case "Unavailable":
      return 69;
    case "Rejected":
      return 2;
    case "StoreFailed":
      return 5;
    default:
      return 1;
  }
};

const execution = (exitCode: number, value: unknown): LocalCliExecution => ({
  exitCode,
  stdout: stableStringify(value),
});

/**
 * Run one local product command.
 *
 * The typed store owns all filesystem observations. This parser starts no
 * process and accepts no shell command string.
 */
export const runLocalCli = (
  argv: ReadonlyArray<string>,
): Effect.Effect<LocalCliExecution, never, LocalFileStore> =>
  Effect.gen(function* () {
    const parsed = parseInspect(argv);
    if (!parsed.ok) {
      return execution(64, {
        _tag: "Rejected",
        phase: "cli-parse",
        code: "invalid_cli_use",
        detail: parsed.detail,
      });
    }

    const store = yield* LocalFileStore;
    const result = yield* Effect.result(store.inspectLocalDocument(parsed.arguments));
    return Result.match(result, {
      onFailure: (failure) => execution(exitCodeForFailure(failure), failure),
      onSuccess: (inspected) => execution(0, inspected),
    });
  });
