const outstanding = [
  "committed tracer fixture",
  "deterministic normalized graph and projections",
  "Bun and Node byte-equivalence journey",
  "generated-view drift gate",
  "acceptance-item evidence manifest",
] as const;

process.stderr.write(
  [
    "Design 0001 is not yet accepted.",
    "The bounded core-validation slice is executable, but these completion gates remain:",
    ...outstanding.map((item) => `- ${item}`),
    "",
  ].join("\n"),
);
process.exitCode = 1;
