# Tracer 0001 integration audit (lead acceptance review)

Audited head: `1622679f71d704e1d55690f3602eea73135961ce`
Observed: 2026-07-31, worktree `/tmp/workgraph-truth-bound-roadmap-lead-0001`,
branch `agent/truth-bound-roadmap-lead-0001`.

This file is an observation record by the integrating lead, not a derived
projection and not proof. It records what was executed and what was observed
in this environment. The requirement-to-command map itself has one home:
`generated/acceptance-contract-coverage.json` (regenerated from
`src/acceptance/manifest.ts`); this audit references it instead of copying it.

## Commands executed (all passed at the audited head)

| Command                                          | Observed result                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile --ignore-scripts` | 47 packages, lockfile unchanged                                                        |
| `bun run check`                                  | format, lint, typecheck, import closure (7 core files), 33 tests / 309 assertions pass |
| `bun run accept:0001`                            | all sections pass with genuine Node 24 (nixpkgs) on PATH                               |
| `git diff --check`                               | clean                                                                                  |
| `git status --short`                             | clean                                                                                  |

Canonical digest observed identically from the Bun journey, the Node journey,
the committed `generated/` tree, and the gate's independent recompute:
`sha256:6b5e49508246f9f1d1ef8f827c1ca2587072fd633c5ea6f8aa27c896c9475fbe`.

Environment note: the PATH `node` in a bare `bun run` context is Bun's shim;
`accept:0001` correctly refuses it. Parity evidence above was produced with a
genuine Node.js runtime, as the gate requires.

## Adversarial probes beyond the committed suite

Executed by the lead against the exact head; none reused suite assertions.

- Deleting `objectId` from the bound machine-check subject at runtime (not
  merely truncating it) → `invalid_git_object_id`, graph rejected.
- Emptying `subjects` on the bound machine check →
  `empty_machine_check_subjects` + `exact_subject_mismatch`, graph rejected.
- Tampering committed `generated/capability-roadmap.json`
  (`available` → `achieved`) → `accept:0001` fails at drift comparison.
- Appending forbidden claim vocabulary to a committed generated view →
  `accept:0001` fails (drift; vocabulary also covered by the claims scan and
  its variation tests).
- Confirmed `.oxlintrc.json` enforces the ambient-capability restriction the
  provenance report claims for `src/core` (restricted globals incl. `Date`,
  `process`, `globalThis`, `crypto`; `Math.random` restricted), and that the
  allowlist import gate covers all 7 core files.

## Review findings

No acceptance clause (items 1–17) failed. Fixture covers all twelve required
fixture bullets, including the legal `supports`/`derived_from` feedback cycle.
Human-approval labeling, correction custody, replay-in-place semantics,
commit-declared request quarantine, and conjoint machine-check binding all
behaved as specified under both the suite and the probes above.

Accepted design smells, documented rather than changed (frozen contract; each
is already recorded as bounded or deferred in
`docs/provenance-and-evidence-limits.md`):

- Fixture-domain policy IDs (`orchard.*`) live in the closed core policy
  registry; generic policy registration is explicitly deferred work.
- The digest-binding recompute shares `stableStringify` with the generator;
  serializer determinism is independently evidenced by Bun/Node byte parity,
  not by that recompute alone.
- The local store remains the committed read-only fixture module, in the
  narrow honest reading the README states.

## Remaining unsupported claims and open work

- No independent review, operational suitability, or human approval is
  established by any run recorded here; this audit is an agent observation.
- The spec deliverable "one public completion PR bound 1:1 to this design
  spec" is outside this worktree's authority (no push/publish) and remains
  open for the operator.
- Exact-head CI/observer binding of an acceptance run (source identity,
  environment, output digest, observation time) remains external, as the
  coverage view's limitations state.
