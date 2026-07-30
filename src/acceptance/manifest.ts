/**
 * Deterministic coverage map for acceptance contract 0001.
 *
 * This source names the checks an external exact-head run must execute. It is
 * not run evidence and never says those checks passed. A caller or CI system
 * must separately record the source revision, environment, disposition,
 * output digest, and observation time for an actual run.
 */

export const ACCEPTANCE_TEST_FILE = "tests/acceptance-0001.test.ts";

export interface AcceptanceCoverageItem {
  readonly item: number;
  readonly requirement: string;
  readonly exercisedBy: ReadonlyArray<string>;
}

export const acceptanceCoverage: ReadonlyArray<AcceptanceCoverageItem> = [
  {
    item: 1,
    requirement:
      "The fixture validates and every canonical transition has at least one typed exact basis reference.",
    exercisedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 1`],
  },
  {
    item: 2,
    requirement: "Removing or weakening a commit object ID makes the dependent transition invalid.",
    exercisedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 2`],
  },
  {
    item: 3,
    requirement: "A branch name alone cannot satisfy an exact-subject requirement.",
    exercisedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 3`],
  },
  {
    item: 4,
    requirement: "A machine check bound to commit A cannot unlock the artifact from commit B.",
    exercisedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 4`],
  },
  {
    item: 5,
    requirement:
      "A human-approved transition is accepted when policy permits it, and every generated view labels it as a human-approved assertion with machine_checked: false.",
    exercisedBy: [
      `bun test ${ACCEPTANCE_TEST_FILE} :: item 5`,
      "bun scripts/accept-0001.ts :: claims-scan",
    ],
  },
  {
    item: 6,
    requirement: "An agent's untyped done assertion cannot satisfy a machine-check gate.",
    exercisedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 6`],
  },
  {
    item: 7,
    requirement:
      "A commit-declared transition request produces no state change until a separate observer event references the immutable resulting commit.",
    exercisedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 7`],
  },
  {
    item: 8,
    requirement:
      "Correcting a transition creates a superseding event and preserves the prior event.",
    exercisedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 8`],
  },
  {
    item: 9,
    requirement: "The canonical graph accepts the fixture's legal feedback cycle.",
    exercisedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 9`],
  },
  {
    item: 10,
    requirement: "A requires or contains cycle fails the applicable projection.",
    exercisedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 10`],
  },
  {
    item: 11,
    requirement:
      "The roadmap derives locked, available, active, achieved, stale, and blocked nodes with source-level explanations.",
    exercisedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 11`],
  },
  {
    item: 12,
    requirement: "AND, OR, and optional prerequisites have distinct, explained unlock semantics.",
    exercisedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 12`],
  },
  {
    item: 13,
    requirement: "Every projection carries the same canonical revision or digest.",
    exercisedBy: [
      `bun test ${ACCEPTANCE_TEST_FILE} :: item 13`,
      "bun scripts/accept-0001.ts :: digest-binding",
    ],
  },
  {
    item: 14,
    requirement: "Editing a generated projection makes the drift check fail.",
    exercisedBy: [
      `bun test ${ACCEPTANCE_TEST_FILE} :: item 14`,
      "bun scripts/accept-0001.ts :: drift-check",
    ],
  },
  {
    item: 15,
    requirement:
      "Bun and Node produce byte-equivalent normalized and derived bounded observations.",
    exercisedBy: ["bun scripts/accept-0001.ts :: bun-node-parity"],
  },
  {
    item: 16,
    requirement: "The portable core transitive import closure reaches no forbidden capability.",
    exercisedBy: ["bun scripts/check-portable-imports.ts"],
  },
  {
    item: 17,
    requirement:
      "No projection claims more than its evidence category supports under the bounded claim vocabulary.",
    exercisedBy: ["bun scripts/accept-0001.ts :: claims-scan"],
  },
];

export const coverageManifest = (canonicalDigest: string): Readonly<Record<string, unknown>> => ({
  canonicalDigest: `sha256:${canonicalDigest}`,
  spec: "design-specs/0001-truth-bound-capability-roadmap.md",
  generator: "workgraph-tracer-0001-acceptance-contract/1",
  artifactKind: "acceptance_contract_coverage",
  items: acceptanceCoverage,
  limitations: [
    "This generated artifact maps requirements to commands; it records no command execution or result.",
    "Actual result binding belongs to a separate external commit or CI observation with exact source identity, environment, disposition, output digest, and observation time.",
  ],
});
