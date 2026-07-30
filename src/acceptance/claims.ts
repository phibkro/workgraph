/**
 * Single source of truth for the unsupported-claim vocabulary (spec 0001,
 * acceptance item 17 and the "Public claims" contract).
 *
 * Both the acceptance gate's claims scan and the test suite consume this
 * module. Patterns are word-bounded and case-insensitive so cosmetic
 * variation ("Proven", "guarantees", "tamper proof") cannot slip past an
 * exact-phrase list. Generated views must phrase their own limitations
 * without this vocabulary; a disclaimer that names a forbidden claim is
 * indistinguishable from the claim in a bounded scan.
 */

export interface ClaimPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

export const FORBIDDEN_CLAIM_PATTERNS: ReadonlyArray<ClaimPattern> = [
  { name: "proof", pattern: /\bproofs?\b|\bproven\b|\bprovably\b/iu },
  { name: "formal-verification", pattern: /\bformal(?:ly)?[\s_-]verif\w*/iu },
  { name: "verified", pattern: /\bverified\b/iu },
  { name: "guarantee", pattern: /\bguarantee(?:s|d)?\b/iu },
  { name: "tamper-proof", pattern: /\btamper[\s_-]?proof\b/iu },
  {
    name: "operational-suitability",
    pattern: /\boperationally[\s_-]suitable\b|\bproduction[\s_-]ready\b/iu,
  },
  { name: "authenticated", pattern: /\bauthenticated\b/iu },
  { name: "certified", pattern: /\bcertif(?:ied|ies)\b/iu },
  { name: "independently-verified", pattern: /\bindependently[\s_-]verified\b/iu },
];

export const unsupportedClaimFindings = (text: string): ReadonlyArray<string> =>
  FORBIDDEN_CLAIM_PATTERNS.filter((claim) => claim.pattern.test(text)).map((claim) => claim.name);
