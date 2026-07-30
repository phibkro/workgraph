/**
 * Portable-core import policy, inverted to an allowlist.
 *
 * The only permitted imports inside src/core are relative imports that
 * resolve within src/core itself. Everything else — bare specifiers such as
 * "fs" or "effect", prefixed specifiers such as "node:fs" or "bun:test",
 * package paths, URLs — is a violation. Denying known-bad prefixes would
 * leave every unanticipated capability (bare "fs", "child_process", a new
 * runtime namespace) silently allowed.
 */

export const PORTABLE_CORE_PREFIX = "src/core/";

const normalizePosix = (path: string): string => {
  const segments: Array<string> = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return "..";
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
};

export const portableImportViolations = (
  filePath: string,
  specifiers: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  specifiers.flatMap((specifier) => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      return [`${filePath}: forbidden non-relative portable-core import '${specifier}'`];
    }
    const directory = filePath.split("/").slice(0, -1).join("/");
    const resolved = normalizePosix(`${directory}/${specifier}`);
    if (!resolved.startsWith(PORTABLE_CORE_PREFIX)) {
      return [`${filePath}: relative import escapes the portable core: '${specifier}'`];
    }
    return [];
  });
