/**
 * Single source of truth for the acceptance-item evidence manifest.
 *
 * The generated `acceptance-evidence.json` projection is derived from this
 * table, and `scripts/accept-0001.ts` drives its executable checks from the
 * same table. The manifest records which executable check establishes each
 * item for a given canonical digest; it is an observation binding, not a
 * standing proof.
 */

export const ACCEPTANCE_TEST_FILE = "tests/acceptance-0001.test.ts";

export interface AcceptanceEvidenceItem {
  readonly item: number;
  readonly requirement: string;
  readonly establishedBy: ReadonlyArray<string>;
  readonly evidenceCategory: "machine_check";
}

export const acceptanceEvidence: ReadonlyArray<AcceptanceEvidenceItem> = [
  {
    item: 1,
    requirement:
      "The fixture validates and every canonical transition has at least one typed exact basis reference.",
    establishedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 1`],
    evidenceCategory: "machine_check",
  },
  {
    item: 2,
    requirement: "Removing or weakening a commit object ID makes the dependent transition invalid.",
    establishedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 2`],
    evidenceCategory: "machine_check",
  },
  {
    item: 3,
    requirement: "A branch name alone cannot satisfy an exact-subject requirement.",
    establishedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 3`],
    evidenceCategory: "machine_check",
  },
  {
    item: 4,
    requirement: "A machine check bound to commit A cannot unlock the artifact from commit B.",
    establishedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 4`],
    evidenceCategory: "machine_check",
  },
  {
    item: 5,
    requirement:
      "A human-approved transition is accepted when policy permits it, and every generated view labels it as a human-approved assertion with machine_checked: false.",
    establishedBy: [
      `bun test ${ACCEPTANCE_TEST_FILE} :: item 5`,
      "bun scripts/accept-0001.ts :: claims-scan",
    ],
    evidenceCategory: "machine_check",
  },
  {
    item: 6,
    requirement: "An agent's untyped done assertion cannot satisfy a machine-check gate.",
    establishedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 6`],
    evidenceCategory: "machine_check",
  },
  {
    item: 7,
    requirement:
      "A commit-declared transition request produces no state change until a separate observer event references the immutable resulting commit.",
    establishedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 7`],
    evidenceCategory: "machine_check",
  },
  {
    item: 8,
    requirement:
      "Correcting a transition creates a superseding event and preserves the prior event.",
    establishedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 8`],
    evidenceCategory: "machine_check",
  },
  {
    item: 9,
    requirement: "The canonical graph accepts the fixture's legal feedback cycle.",
    establishedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 9`],
    evidenceCategory: "machine_check",
  },
  {
    item: 10,
    requirement: "A requires or contains cycle fails the applicable projection.",
    establishedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 10`],
    evidenceCategory: "machine_check",
  },
  {
    item: 11,
    requirement:
      "The roadmap derives locked, available, active, achieved, stale, and blocked nodes with source-level explanations.",
    establishedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 11`],
    evidenceCategory: "machine_check",
  },
  {
    item: 12,
    requirement: "AND and OR prerequisites unlock exactly the intended capability paths.",
    establishedBy: [`bun test ${ACCEPTANCE_TEST_FILE} :: item 12`],
    evidenceCategory: "machine_check",
  },
  {
    item: 13,
    requirement: "Every projection carries the same canonical revision or digest.",
    establishedBy: [
      `bun test ${ACCEPTANCE_TEST_FILE} :: item 13`,
      "bun scripts/accept-0001.ts :: digest-binding",
    ],
    evidenceCategory: "machine_check",
  },
  {
    item: 14,
    requirement: "Editing a generated projection makes the drift check fail.",
    establishedBy: [
      `bun test ${ACCEPTANCE_TEST_FILE} :: item 14`,
      "bun scripts/accept-0001.ts :: drift-check",
    ],
    evidenceCategory: "machine_check",
  },
  {
    item: 15,
    requirement:
      "Bun and Node produce byte-equivalent normalized and derived bounded observations.",
    establishedBy: ["bun scripts/accept-0001.ts :: bun-node-parity"],
    evidenceCategory: "machine_check",
  },
  {
    item: 16,
    requirement:
      "The portable core's transitive import closure reaches no runtime, filesystem, process, network, clock, random, GitHub, Herdr, or Semantic Systems capability.",
    establishedBy: ["bun scripts/check-portable-imports.ts"],
    evidenceCategory: "machine_check",
  },
  {
    item: 17,
    requirement:
      "No unsupported proof, authentication, execution, or operational-suitability claim appears in any projection.",
    establishedBy: ["bun scripts/accept-0001.ts :: claims-scan"],
    evidenceCategory: "machine_check",
  },
];

export const evidenceManifest = (canonicalDigest: string): Readonly<Record<string, unknown>> => ({
  canonicalDigest: `sha256:${canonicalDigest}`,
  spec: "design-specs/0001-truth-bound-capability-roadmap.md",
  generator: "workgraph-tracer-0001-acceptance/1",
  items: acceptanceEvidence,
  limitations: [
    "Each item is established per run by the named executable checks; this manifest records the binding for the stated canonical digest, not a standing guarantee.",
    "Machine checks establish that the named checks passed; they do not establish operational suitability, formal proof, or human intent.",
  ],
});
