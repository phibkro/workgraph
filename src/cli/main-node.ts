import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Effect, Layer } from "effect";
import { runCli, webCryptoSha256 } from "./journey.ts";
import { runLocalCli } from "./local-command.ts";
import { nodeLocalFileStoreLayer } from "../local/node-file-store.ts";

const journeyLayers = Layer.mergeAll(NodeFileSystem.layer, webCryptoSha256);
const argv = process.argv.slice(2);
const isJourneyCommand = argv[0] === "generate" || argv[0] === "check";
const program = isJourneyCommand
  ? runCli(argv).pipe(
      Effect.provide(journeyLayers),
      Effect.map((message) => ({ exitCode: 0, stdout: `${message}\n` })),
    )
  : runLocalCli(argv).pipe(Effect.provide(nodeLocalFileStoreLayer));

Effect.runPromise(program)
  .then((result) => {
    process.exitCode = result.exitCode;
    return process.stdout.write(result.stdout);
  })
  .catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
