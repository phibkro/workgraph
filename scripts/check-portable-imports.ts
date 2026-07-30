const forbiddenBareImports = new Set(["bun", "effect", "herdr", "semantic-systems"]);
const forbiddenPrefixes = ["node:", "bun:", "@effect/", "@octokit/", "herdr/", "semantic-systems/"];
const transpiler = new Bun.Transpiler({ loader: "ts" });

const files = [...new Bun.Glob("src/core/**/*.ts").scanSync({ onlyFiles: true })].toSorted();
const violations = (
  await Promise.all(
    files.map(async (path) => {
      const source = await Bun.file(path).text();
      const imports = transpiler.scanImports(source);

      return imports.flatMap((imported) => {
        const specifier = imported.path;
        if (
          forbiddenBareImports.has(specifier) ||
          forbiddenPrefixes.some((prefix) => specifier.startsWith(prefix))
        ) {
          return [`${path}: forbidden portable-core import '${specifier}'`];
        }
        return [];
      });
    }),
  )
).flat();

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`portable import closure: ${files.length} files accepted\n`);
}
