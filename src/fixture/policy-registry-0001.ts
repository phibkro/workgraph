import {
  resolvePolicyRegistry,
  type PolicyRegistry,
  type TransitionPolicyDefinition,
} from "../core/policy-registry.ts";

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

export const ORCHARD_TRANSITION_POLICIES: ReadonlyArray<TransitionPolicyDefinition> = [
  machinePolicy("orchard.policy.probe-acceptance", "orchard.policy.probe-acceptance/v1"),
  machinePolicy("orchard.policy.gate-0001", "orchard.policy.gate-0001/v1"),
  machinePolicy("orchard.policy.replay", "orchard.policy.replay/v1"),
];

const resolution = resolvePolicyRegistry(ORCHARD_TRANSITION_POLICIES);
if (!resolution.ok) {
  throw new Error(
    `invalid tracer 0001 registry: ${resolution.issues.map((issue) => issue.code).join(",")}`,
  );
}

export const policyRegistry0001: PolicyRegistry = resolution.registry;
