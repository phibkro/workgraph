import {
  LIFECYCLE_STATES,
  type AuthorityKind,
  type EvidenceCategory,
  type LifecycleState,
  type TransitionEvent,
} from "./model.ts";
import { immutableSnapshot, stableStringify } from "./normalize.ts";

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

export type RegistryHashFunction = (text: string) => `sha256:${string}`;

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

export const GENERIC_TRANSITION_POLICIES: ReadonlyArray<TransitionPolicyDefinition> =
  immutableSnapshot([
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
  ]);

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

const sameIdentity = (
  left: Pick<TransitionPolicyDefinition, "id" | "version">,
  right: Pick<TransitionPolicyDefinition, "id" | "version">,
): boolean => left.id === right.id && left.version === right.version;

const normalizeDefinition = (
  definition: TransitionPolicyDefinition,
): TransitionPolicyDefinition => ({
  id: definition.id,
  version: definition.version,
  authority: definition.authority,
  evidenceCategory: definition.evidenceCategory,
  rules: definition.rules
    .map((rule) => ({
      priorState: rule.priorState,
      requestedState: rule.requestedState,
      transitionKind: rule.transitionKind,
    }))
    .toSorted((left, right) => byCodeUnit(ruleTuple(left), ruleTuple(right))),
  ...(definition.acceptanceContract === undefined
    ? {}
    : { acceptanceContract: definition.acceptanceContract }),
});

const normalizeCompleteRegistry = (
  definitions: ReadonlyArray<TransitionPolicyDefinition>,
): RegistryResolution => {
  const issues: Array<RegistryIssue> = [];
  const identities: Array<Pick<TransitionPolicyDefinition, "id" | "version">> = [];

  for (const definition of definitions) {
    if (definition.id.length === 0 || definition.version.length === 0) {
      issues.push({
        code: "empty_policy_identity",
        detail: "Policy identity fields are required.",
      });
    }
    if (identities.some((identity) => sameIdentity(identity, definition))) {
      issues.push({
        code: "duplicate_policy_identity",
        detail: `Duplicate policy ${definition.id}@${definition.version}.`,
      });
    }
    identities.push({ id: definition.id, version: definition.version });
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

  const normalized = definitions.map(normalizeDefinition).toSorted((left, right) => {
    const idOrder = byCodeUnit(left.id, right.id);
    return idOrder === 0 ? byCodeUnit(left.version, right.version) : idOrder;
  });
  const registry = immutableSnapshot<PolicyRegistry>({
    schemaVersion: "workgraph.policy-registry/v1alpha1",
    definitions: normalized,
  });
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

export const resolvePolicyRegistry = (
  optionalDefinitions: ReadonlyArray<TransitionPolicyDefinition> = [],
): RegistryResolution =>
  normalizeCompleteRegistry([...GENERIC_TRANSITION_POLICIES, ...optionalDefinitions]);

export const attachPolicyRegistryDigest = (
  resolution: Extract<RegistryResolution, { readonly ok: true }>,
  hash: RegistryHashFunction,
): ResolvedPolicyRegistry => {
  const digest = hash(resolution.digestScope);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new TypeError("Registry hash function returned an invalid SHA-256 digest.");
  }
  return immutableSnapshot({
    ...resolution.registry,
    schemaVersion: "workgraph.resolved-policy-registry/v1alpha1",
    digest,
  });
};

export const authenticatePolicyRegistry = (
  registry: ResolvedPolicyRegistry,
  hash: RegistryHashFunction,
): boolean => {
  const resolution = normalizeCompleteRegistry(registry.definitions);
  if (!resolution.ok) return false;
  for (const builtin of GENERIC_TRANSITION_POLICIES) {
    const actual = resolution.registry.definitions.find((definition) =>
      sameIdentity(definition, builtin),
    );
    if (
      actual === undefined ||
      stableStringify(normalizeDefinition(actual)) !== stableStringify(normalizeDefinition(builtin))
    ) {
      return false;
    }
  }
  return hash(resolution.digestScope) === registry.digest;
};

export const findPolicy = (
  registry: PolicyRegistry,
  id: string,
  version: string,
): TransitionPolicyDefinition | undefined =>
  registry.definitions.find((definition) => definition.id === id && definition.version === version);
