import { portableImportViolations } from "./portable-import-policy.ts";

const transpiler = new Bun.Transpiler({ loader: "ts" });

const files = [...new Bun.Glob("src/core/**/*.ts").scanSync({ onlyFiles: true })].toSorted();
const violations = (
  await Promise.all(
    files.map(async (path) => {
      const source = await Bun.file(path).text();
      const imports = transpiler.scanImports(source);
      return portableImportViolations(
        path,
        imports.map((imported) => imported.path),
      );
    }),
  )
).flat();

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`portable import closure (allowlist): ${files.length} files accepted\n`);
}
