import type { AuthorityKind, EvidenceCategory, TransitionEvent, WorkNode } from "./model.ts";
import {
  findPolicy,
  type PolicyRegistry,
  type TransitionPolicyDefinition,
} from "./policy-registry.ts";
import { sameExactReference } from "./references.ts";

export type { TransitionPolicyDefinition, TransitionPolicyRule } from "./policy-registry.ts";

export interface PolicyIssue {
  readonly code: string;
  readonly detail: string;
}

export interface ValidatedTransitionEvidence {
  readonly authority: AuthorityKind;
  readonly category: EvidenceCategory;
  readonly machineChecked: boolean;
  readonly humanApprovedAssertion: boolean;
  readonly rulesFired: ReadonlyArray<string>;
}

export interface PolicyEvaluation {
  readonly policy?: TransitionPolicyDefinition;
  readonly issues: ReadonlyArray<PolicyIssue>;
  readonly evidence?: ValidatedTransitionEvidence;
}

const exactSubjectInBasis = (event: TransitionEvent, node: WorkNode): boolean => {
  if (node.exactSubject === undefined) return true;
  if (event.authority === "machine_policy") {
    return event.basis.some(
      (reference) =>
        reference.kind === "machine_check" &&
        reference.subjects.some((subject) => sameExactReference(subject, node.exactSubject!)),
    );
  }
  if (event.authority === "human_approval") {
    return event.basis.some(
      (reference) =>
        reference.kind === "human_approval" &&
        reference.subjects.some((subject) => sameExactReference(subject, node.exactSubject!)),
    );
  }
  return event.basis.some((reference) => {
    if (reference.kind === "git_commit" || reference.kind === "artifact") {
      return sameExactReference(reference, node.exactSubject!);
    }
    return false;
  });
};

export const evaluateTransitionPolicy = (
  event: TransitionEvent,
  node: WorkNode,
  registry: PolicyRegistry,
): PolicyEvaluation => {
  const policy = findPolicy(registry, event.policy, event.policyVersion);
  if (policy === undefined) {
    return {
      issues: [
        {
          code: "unknown_transition_policy",
          detail: `No transition policy is registered as ${event.policy}@${event.policyVersion}.`,
        },
      ],
    };
  }

  const issues: Array<PolicyIssue> = [];
  if (event.authority !== policy.authority) {
    issues.push({
      code: "policy_authority_mismatch",
      detail: `Policy ${policy.id}@${policy.version} requires authority ${policy.authority}.`,
    });
  }
  if (event.evidenceCategory !== policy.evidenceCategory) {
    issues.push({
      code: "policy_evidence_category_mismatch",
      detail: `Policy ${policy.id}@${policy.version} derives ${policy.evidenceCategory}, not ${event.evidenceCategory}.`,
    });
  }
  if (
    !policy.rules.some(
      (rule) =>
        rule.priorState === event.priorState &&
        rule.requestedState === event.requestedState &&
        rule.transitionKind === event.transitionKind,
    )
  ) {
    issues.push({
      code: "transition_edge_not_allowed",
      detail: `Policy ${policy.id}@${policy.version} does not allow ${String(event.priorState)} -> ${event.requestedState} (${event.transitionKind}).`,
    });
  }
  if (!exactSubjectInBasis(event, node)) {
    issues.push({
      code: "exact_subject_mismatch",
      detail: "Transition evidence is not bound to the node exact subject.",
    });
  }

  if (policy.authority === "machine_policy") {
    if (node.exactSubject === undefined) {
      issues.push({
        code: "machine_policy_unbound_subject",
        detail: "Machine policy requires a node exact subject.",
      });
    } else {
      const checks = event.basis.filter((reference) => reference.kind === "machine_check");
      const contractChecks = checks.filter((check) => check.policy === policy.acceptanceContract);
      const qualifying = contractChecks.filter(
        (check) =>
          check.result === "passed" &&
          check.exitCode === 0 &&
          check.subjects.some((subject) => sameExactReference(subject, node.exactSubject!)),
      );
      if (checks.length === 0) {
        issues.push({
          code: "machine_policy_without_check",
          detail: "Machine policy requires a machine-check basis.",
        });
      } else if (contractChecks.length === 0) {
        issues.push({
          code: "machine_check_policy_mismatch",
          detail: `No machine check names acceptance contract ${String(policy.acceptanceContract)}.`,
        });
      } else if (qualifying.length === 0) {
        issues.push({
          code: "machine_check_not_bound_and_passing",
          detail:
            "No passing, zero-exit check for the named contract names the node exact subject.",
        });
      }
    }
  }

  if (policy.authority === "human_approval") {
    if (node.exactSubject === undefined) {
      issues.push({
        code: "human_approval_unbound_subject",
        detail: "Human approval policy requires a node exact subject.",
      });
    } else {
      const qualifying = event.basis.filter(
        (reference) =>
          reference.kind === "human_approval" &&
          reference.approvedTransition === event.requestedState &&
          reference.evidenceCategory === "human_approved_assertion" &&
          reference.machineChecked === false &&
          reference.subjects.some((subject) => sameExactReference(subject, node.exactSubject!)),
      );
      if (qualifying.length === 0) {
        issues.push({
          code: "human_approval_not_bound",
          detail:
            "No explicitly non-machine-checked approval names the transition and node exact subject.",
        });
      }
    }
  }

  if (
    policy.authority === "imported_observation" &&
    !event.basis.some((reference) => reference.kind === "external_record")
  ) {
    issues.push({
      code: "imported_observation_without_external_record",
      detail: "Imported-observation policy requires an immutable external-record basis.",
    });
  }

  if (issues.length > 0) return { policy, issues };
  return {
    policy,
    issues: [],
    evidence: {
      authority: policy.authority,
      category: policy.evidenceCategory,
      machineChecked: policy.authority === "machine_policy",
      humanApprovedAssertion: policy.authority === "human_approval",
      rulesFired: [
        `rule.transition-policy.${policy.id}@${policy.version}`,
        `rule.authority-evidence.${policy.authority}->${policy.evidenceCategory}`,
        ...(policy.acceptanceContract === undefined
          ? []
          : [`rule.acceptance-contract.${policy.acceptanceContract}`]),
      ],
    },
  };
};
