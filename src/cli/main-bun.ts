import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import { runCli, webCryptoSha256 } from "./journey.ts";

const layers = Layer.mergeAll(BunFileSystem.layer, webCryptoSha256);

Effect.runPromise(runCli(process.argv.slice(2)).pipe(Effect.provide(layers)))
  .then((message) => process.stdout.write(`${message}\n`))
  .catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
