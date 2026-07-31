import {
  LIFECYCLE_STATES,
  type AuthorityKind,
  type EvidenceCategory,
  type LifecycleState,
  type TransitionEvent,
} from "./model.ts";
import { stableStringify } from "./normalize.ts";

export interface TransitionPolicyRule {
  readonly priorState: LifecycleState | null;
  readonly requestedState: LifecycleState;
  readonly transitionKind: TransitionEvent["transitionKind"];
}

export interface TransitionPolicyDefinition {
  readonly id: string;
  readonly version: string;
  readonly authority: AuthorityKind;
  readonly evidenceCategory: EvidenceCategory;
  readonly rules: ReadonlyArray<TransitionPolicyRule>;
  readonly acceptanceContract?: string;
}

export interface PolicyDefinitionsDocument {
  readonly schemaVersion: "workgraph.policy-definitions/v1alpha1";
  readonly definitions: ReadonlyArray<TransitionPolicyDefinition>;
}

export interface PolicyRegistry {
  readonly schemaVersion:
    | "workgraph.policy-registry/v1alpha1"
    | "workgraph.resolved-policy-registry/v1alpha1";
  readonly definitions: ReadonlyArray<TransitionPolicyDefinition>;
  readonly byIdentity: ReadonlyMap<string, TransitionPolicyDefinition>;
}

export interface ResolvedPolicyRegistry extends PolicyRegistry {
  readonly schemaVersion: "workgraph.resolved-policy-registry/v1alpha1";
  readonly digest: `sha256:${string}`;
}

export interface RegistryIssue {
  readonly code: string;
  readonly detail: string;
}

export type RegistryResolution =
  | { readonly ok: true; readonly registry: PolicyRegistry; readonly digestScope: string }
  | { readonly ok: false; readonly issues: ReadonlyArray<RegistryIssue> };

const ADMINISTRATIVE_ADVANCES: ReadonlyArray<TransitionPolicyRule> = [
  { priorState: null, requestedState: "active", transitionKind: "advance" },
  { priorState: null, requestedState: "achieved", transitionKind: "advance" },
  { priorState: "active", requestedState: "achieved", transitionKind: "advance" },
  { priorState: "achieved", requestedState: "abandoned", transitionKind: "advance" },
];

const ADMINISTRATIVE_CORRECTIONS: ReadonlyArray<TransitionPolicyRule> = [
  { priorState: null, requestedState: "active", transitionKind: "correct" },
  { priorState: null, requestedState: "achieved", transitionKind: "correct" },
  { priorState: null, requestedState: "stale", transitionKind: "correct" },
  { priorState: "active", requestedState: "achieved", transitionKind: "correct" },
];

const machinePolicy = (id: string, acceptanceContract: string): TransitionPolicyDefinition => ({
  id,
  version: "1",
  authority: "machine_policy",
  evidenceCategory: "machine_check",
  acceptanceContract,
  rules: [
    { priorState: null, requestedState: "achieved", transitionKind: "advance" },
    { priorState: "active", requestedState: "achieved", transitionKind: "advance" },
  ],
});

export const GENERIC_TRANSITION_POLICIES: ReadonlyArray<TransitionPolicyDefinition> = [
  {
    id: "workgraph.policy.administrative",
    version: "1",
    authority: "administrative_assertion",
    evidenceCategory: "agent_assertion",
    rules: [...ADMINISTRATIVE_ADVANCES, ...ADMINISTRATIVE_CORRECTIONS],
  },
  {
    id: "workgraph.policy.administrative-assumption",
    version: "1",
    authority: "administrative_assertion",
    evidenceCategory: "assumption",
    rules: ADMINISTRATIVE_ADVANCES,
  },
  {
    id: "workgraph.policy.human-approval",
    version: "1",
    authority: "human_approval",
    evidenceCategory: "human_approved_assertion",
    rules: [{ priorState: null, requestedState: "achieved", transitionKind: "advance" }],
  },
  {
    id: "workgraph.policy.imported-observation",
    version: "1",
    authority: "imported_observation",
    evidenceCategory: "external_observation",
    rules: [
      { priorState: null, requestedState: "active", transitionKind: "advance" },
      { priorState: null, requestedState: "achieved", transitionKind: "advance" },
    ],
  },
  machinePolicy("workgraph.policy.machine-check", "workgraph.policy.machine-check/v1"),
];

const AUTHORITIES: ReadonlySet<string> = new Set([
  "machine_policy",
  "human_approval",
  "imported_observation",
  "administrative_assertion",
]);
const CATEGORIES: ReadonlySet<string> = new Set([
  "machine_check",
  "human_approved_assertion",
  "external_observation",
  "agent_assertion",
  "assumption",
]);
const TRANSITION_KINDS: ReadonlySet<string> = new Set(["advance", "reopen", "correct"]);
const STATES: ReadonlySet<string | null> = new Set([null, ...LIFECYCLE_STATES]);

const byCodeUnit = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const ruleTuple = (rule: TransitionPolicyRule): string =>
  `${rule.priorState ?? ""}\u0000${rule.requestedState}\u0000${rule.transitionKind}`;

const normalizeDefinition = (
  definition: TransitionPolicyDefinition,
): TransitionPolicyDefinition => ({
  id: definition.id,
  version: definition.version,
  authority: definition.authority,
  evidenceCategory: definition.evidenceCategory,
  rules: definition.rules.toSorted((left, right) => byCodeUnit(ruleTuple(left), ruleTuple(right))),
  ...(definition.acceptanceContract === undefined
    ? {}
    : { acceptanceContract: definition.acceptanceContract }),
});

export const resolvePolicyRegistry = (
  optionalDefinitions: ReadonlyArray<TransitionPolicyDefinition> = [],
): RegistryResolution => {
  const definitions = [...GENERIC_TRANSITION_POLICIES, ...optionalDefinitions];
  const issues: Array<RegistryIssue> = [];
  const identities = new Set<string>();

  for (const definition of definitions) {
    const identity = `${definition.id}\u0000${definition.version}`;
    if (definition.id.length === 0 || definition.version.length === 0) {
      issues.push({
        code: "empty_policy_identity",
        detail: "Policy identity fields are required.",
      });
    }
    if (identities.has(identity)) {
      issues.push({
        code: "duplicate_policy_identity",
        detail: `Duplicate policy ${definition.id}@${definition.version}.`,
      });
    }
    identities.add(identity);
    if (!AUTHORITIES.has(definition.authority)) {
      issues.push({ code: "unknown_policy_authority", detail: definition.authority });
    }
    if (!CATEGORIES.has(definition.evidenceCategory)) {
      issues.push({
        code: "unknown_policy_evidence_category",
        detail: definition.evidenceCategory,
      });
    }
    const tuples = new Set<string>();
    for (const rule of definition.rules) {
      const tuple = ruleTuple(rule);
      if (
        !STATES.has(rule.priorState) ||
        !STATES.has(rule.requestedState) ||
        !TRANSITION_KINDS.has(rule.transitionKind)
      ) {
        issues.push({
          code: "unknown_policy_rule_value",
          detail: `${definition.id}@${definition.version}: ${tuple}`,
        });
      }
      if (tuples.has(tuple)) {
        issues.push({
          code: "duplicate_policy_rule",
          detail: `${definition.id}@${definition.version}: ${tuple}`,
        });
      }
      tuples.add(tuple);
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  const normalized = definitions
    .map(normalizeDefinition)
    .toSorted((left, right) =>
      byCodeUnit(`${left.id}\u0000${left.version}`, `${right.id}\u0000${right.version}`),
    );
  const registry: PolicyRegistry = {
    schemaVersion: "workgraph.policy-registry/v1alpha1",
    definitions: normalized,
    byIdentity: new Map(
      normalized.map((definition) => [`${definition.id}\u0000${definition.version}`, definition]),
    ),
  };
  return {
    ok: true,
    registry,
    digestScope: stableStringify({
      schemaVersion: "workgraph.resolved-policy-registry/v1alpha1",
      definitions: normalized.map((definition) => ({
        id: definition.id,
        version: definition.version,
        authority: definition.authority,
        evidenceCategory: definition.evidenceCategory,
        rules: definition.rules,
        acceptanceContract: definition.acceptanceContract ?? null,
      })),
    }),
  };
};

export const attachPolicyRegistryDigest = (
  resolution: Extract<RegistryResolution, { readonly ok: true }>,
  hexDigest: string,
): ResolvedPolicyRegistry => ({
  ...resolution.registry,
  schemaVersion: "workgraph.resolved-policy-registry/v1alpha1",
  digest: `sha256:${hexDigest}`,
});

export const findPolicy = (
  registry: PolicyRegistry,
  id: string,
  version: string,
): TransitionPolicyDefinition | undefined => registry.byIdentity.get(`${id}\u0000${version}`);
