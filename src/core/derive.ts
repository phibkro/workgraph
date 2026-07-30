import type {
  EvidenceCategory,
  LifecycleState,
  TransitionEvent,
  WorkEdge,
  WorkGraph,
  WorkNode,
} from "./model.ts";
import { validateGraph } from "./graph.ts";

export const DERIVATION_POLICY = "workgraph.policy.roadmap-derivation";
export const DERIVATION_POLICY_VERSION = "1";

export const DERIVED_VALUES = [
  "locked",
  "available",
  "active",
  "waiting",
  "blocked",
  "achieved",
  "stale",
  "invalid",
] as const;

export type DerivedValue = (typeof DERIVED_VALUES)[number];

export interface DerivedStatus {
  readonly subjectId: string;
  readonly value: DerivedValue;
  readonly policy: string;
  readonly policyVersion: string;
  readonly rulesFired: ReadonlyArray<string>;
  readonly sourceNodes: ReadonlyArray<string>;
  readonly sourceEdges: ReadonlyArray<string>;
  readonly sourceEvents: ReadonlyArray<string>;
  readonly unsatisfiedPrerequisites: ReadonlyArray<string>;
  readonly limitations: ReadonlyArray<string>;
}

export interface PrerequisiteAlternative {
  readonly targetId: string;
  readonly edgeId: string;
  readonly satisfied: boolean;
}

export interface OrGroupReport {
  readonly group: string;
  readonly alternatives: ReadonlyArray<PrerequisiteAlternative>;
  readonly satisfied: boolean;
}

export interface PrerequisiteReport {
  readonly subjectId: string;
  readonly andPrerequisites: ReadonlyArray<PrerequisiteAlternative>;
  readonly orGroups: ReadonlyArray<OrGroupReport>;
  readonly satisfied: boolean;
}

export const MATURITY_RUNGS = [
  "unexplored",
  "researched",
  "specified",
  "executable_tracer_observed",
  "independently_reviewed",
  "integrated",
  "operationally_observed",
] as const;

export type MaturityRung = (typeof MATURITY_RUNGS)[number];

export interface RungEvidence {
  readonly rung: MaturityRung;
  readonly rule: string;
  readonly sourceNodes: ReadonlyArray<string>;
  readonly sourceEdges: ReadonlyArray<string>;
  readonly sourceEvents: ReadonlyArray<string>;
}

export interface CapabilityMaturity {
  readonly capabilityId: string;
  readonly displayLevel: MaturityRung;
  readonly satisfiedRungs: ReadonlyArray<RungEvidence>;
  readonly unsatisfiedRungs: ReadonlyArray<MaturityRung>;
  readonly limitations: ReadonlyArray<string>;
}

export interface Derivation {
  readonly policy: string;
  readonly policyVersion: string;
  readonly statuses: ReadonlyArray<DerivedStatus>;
  readonly prerequisites: ReadonlyArray<PrerequisiteReport>;
  readonly capabilities: ReadonlyArray<CapabilityMaturity>;
  readonly frontier: ReadonlyArray<string>;
  readonly unlocks: ReadonlyArray<{
    readonly subjectId: string;
    readonly unlocksSubjectIds: ReadonlyArray<string>;
  }>;
}

interface LifecycleFact {
  readonly state: LifecycleState;
  readonly event: TransitionEvent;
}

const byCodeUnit = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const latestLifecycle = (graph: WorkGraph): ReadonlyMap<string, LifecycleFact> => {
  const facts = new Map<string, LifecycleFact>();
  for (const event of graph.events) {
    facts.set(event.subjectId, { state: event.requestedState, event });
  }
  return facts;
};

const orGroupOf = (edge: WorkEdge): string | undefined => {
  const value = edge.attributes?.["orGroup"];
  return typeof value === "string" ? value : undefined;
};

const RESOLVED_BLOCKER_STATES: ReadonlySet<string> = new Set(["achieved", "abandoned"]);

export const deriveRoadmap = (graph: WorkGraph): Derivation => {
  const validation = validateGraph(graph);
  const invalidSubjects = new Set(validation.issues.map((issue) => issue.subject));
  const lifecycle = latestLifecycle(graph);
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));

  const requiresBySource = new Map<string, Array<WorkEdge>>();
  const containsBySource = new Map<string, Array<WorkEdge>>();
  const contradictsByTarget = new Map<string, Array<WorkEdge>>();
  const blocksByTarget = new Map<string, Array<WorkEdge>>();
  for (const edge of graph.edges) {
    if (edge.kind === "requires") {
      requiresBySource.set(edge.from, [...(requiresBySource.get(edge.from) ?? []), edge]);
    }
    if (edge.kind === "contains") {
      containsBySource.set(edge.from, [...(containsBySource.get(edge.from) ?? []), edge]);
    }
    if (edge.kind === "contradicts") {
      contradictsByTarget.set(edge.to, [...(contradictsByTarget.get(edge.to) ?? []), edge]);
    }
    if (edge.kind === "blocks") {
      blocksByTarget.set(edge.to, [...(blocksByTarget.get(edge.to) ?? []), edge]);
    }
  }

  interface BaseStatus {
    readonly value: DerivedValue;
    readonly rulesFired: Array<string>;
    readonly sourceNodes: Array<string>;
    readonly sourceEdges: Array<string>;
    readonly sourceEvents: Array<string>;
    readonly unsatisfiedPrerequisites: Array<string>;
    readonly limitations: Array<string>;
  }

  /**
   * An observation stands unless a live counter-observation contradicts it.
   * The contradicting node must itself be observed (achieved or active).
   */
  const activeContradictions = (subjectId: string): ReadonlyArray<WorkEdge> =>
    (contradictsByTarget.get(subjectId) ?? []).filter((edge) => {
      const sourceState = lifecycle.get(edge.from)?.state;
      return sourceState === "achieved" || sourceState === "active";
    });

  const prerequisiteReport = (subjectId: string): PrerequisiteReport => {
    const edges = requiresBySource.get(subjectId) ?? [];
    const isSatisfied = (edge: WorkEdge): boolean => lifecycle.get(edge.to)?.state === "achieved";
    const andEdges = edges.filter((edge) => orGroupOf(edge) === undefined);
    const groupNames = [
      ...new Set(edges.map(orGroupOf).filter((group) => group !== undefined)),
    ].toSorted(byCodeUnit);

    const andPrerequisites = andEdges.map((edge) => ({
      targetId: edge.to,
      edgeId: edge.id,
      satisfied: isSatisfied(edge),
    }));
    const orGroups = groupNames.map((group) => {
      const alternatives = edges
        .filter((edge) => orGroupOf(edge) === group)
        .map((edge) => ({ targetId: edge.to, edgeId: edge.id, satisfied: isSatisfied(edge) }));
      return { group, alternatives, satisfied: alternatives.some((entry) => entry.satisfied) };
    });

    return {
      subjectId,
      andPrerequisites,
      orGroups,
      satisfied:
        andPrerequisites.every((entry) => entry.satisfied) &&
        orGroups.every((group) => group.satisfied),
    };
  };

  const prerequisites = graph.nodes
    .filter((node) => (requiresBySource.get(node.id) ?? []).length > 0)
    .map((node) => prerequisiteReport(node.id))
    .toSorted((a, b) => byCodeUnit(a.subjectId, b.subjectId));
  const prerequisitesById = new Map(prerequisites.map((report) => [report.subjectId, report]));

  const baseStatus = (node: WorkNode): BaseStatus => {
    if (invalidSubjects.has(node.id)) {
      return {
        value: "invalid",
        rulesFired: ["rule.invalid_subject"],
        sourceNodes: [node.id],
        sourceEdges: [],
        sourceEvents: [],
        unsatisfiedPrerequisites: validation.issues
          .filter((issue) => issue.subject === node.id)
          .map((issue) => issue.code),
        limitations: [],
      };
    }

    const rawFact = lifecycle.get(node.id);
    const contradictions = activeContradictions(node.id);
    // A "declared" lifecycle records intent only; availability still derives
    // from prerequisites below.
    const fact = rawFact?.state === "declared" ? undefined : rawFact;

    if (fact !== undefined && fact.state !== "declared") {
      if (contradictions.length > 0 && fact.state !== "abandoned") {
        return {
          value: "stale",
          rulesFired: ["rule.event_lifecycle", "rule.contradicted_by_observation"],
          sourceNodes: contradictions.map((edge) => edge.from),
          sourceEdges: contradictions.map((edge) => edge.id),
          sourceEvents: [fact.event.id],
          unsatisfiedPrerequisites: [],
          limitations: [
            "Staleness marks a live contradiction; it does not erase the earlier accepted history.",
          ],
        };
      }
      const value: DerivedValue = fact.state === "abandoned" ? "stale" : fact.state;
      return {
        value,
        rulesFired:
          fact.state === "abandoned"
            ? ["rule.event_lifecycle", "rule.abandoned_displayed_as_stale"]
            : ["rule.event_lifecycle"],
        sourceNodes: [node.id],
        sourceEdges: [],
        sourceEvents: [fact.event.id],
        unsatisfiedPrerequisites: [],
        limitations:
          fact.state === "abandoned"
            ? ["The canonical lifecycle is abandoned; the roadmap displays it as stale."]
            : [],
      };
    }

    const members = containsBySource.get(node.id) ?? [];
    if (node.kind === "milestone" && members.length > 0) {
      const pending = members.filter((edge) => lifecycle.get(edge.to)?.state !== "achieved");
      if (pending.length === 0) {
        return {
          value: "achieved",
          rulesFired: ["rule.milestone_envelope_satisfied"],
          sourceNodes: members.map((edge) => edge.to),
          sourceEdges: members.map((edge) => edge.id),
          sourceEvents: members.flatMap((edge) => {
            const memberFact = lifecycle.get(edge.to);
            return memberFact === undefined ? [] : [memberFact.event.id];
          }),
          unsatisfiedPrerequisites: [],
          limitations: [
            "Milestone acceptance is derived from its contained members' accepted events.",
          ],
        };
      }
      return {
        value: "waiting",
        rulesFired: ["rule.milestone_envelope_pending"],
        sourceNodes: members.map((edge) => edge.to),
        sourceEdges: members.map((edge) => edge.id),
        sourceEvents: [],
        unsatisfiedPrerequisites: pending.map((edge) => edge.to),
        limitations: [],
      };
    }

    const report = prerequisitesById.get(node.id);
    if (report !== undefined) {
      if (report.satisfied) {
        return {
          value: "available",
          rulesFired: ["rule.requires_satisfied"],
          sourceNodes: (requiresBySource.get(node.id) ?? []).map((edge) => edge.to),
          sourceEdges: (requiresBySource.get(node.id) ?? []).map((edge) => edge.id),
          sourceEvents: (requiresBySource.get(node.id) ?? []).flatMap((edge) => {
            const targetFact = lifecycle.get(edge.to);
            return targetFact === undefined ? [] : [targetFact.event.id];
          }),
          unsatisfiedPrerequisites: [],
          limitations: [],
        };
      }
      const unsatisfied = [
        ...report.andPrerequisites
          .filter((entry) => !entry.satisfied)
          .map((entry) => `requires ${entry.targetId} achieved`),
        ...report.orGroups
          .filter((group) => !group.satisfied)
          .map(
            (group) =>
              `requires one of [${group.alternatives.map((entry) => entry.targetId).join(", ")}] achieved`,
          ),
      ];
      return {
        value: "locked",
        rulesFired: ["rule.requires_unsatisfied"],
        sourceNodes: (requiresBySource.get(node.id) ?? []).map((edge) => edge.to),
        sourceEdges: (requiresBySource.get(node.id) ?? []).map((edge) => edge.id),
        sourceEvents: [],
        unsatisfiedPrerequisites: unsatisfied,
        limitations: [],
      };
    }

    return {
      value: "available",
      rulesFired: ["rule.no_prerequisites"],
      sourceNodes: [node.id],
      sourceEdges: [],
      sourceEvents: [],
      unsatisfiedPrerequisites: [],
      limitations: ["No transition history and no declared prerequisites."],
    };
  };

  const bases = new Map(graph.nodes.map((node) => [node.id, baseStatus(node)]));

  const statuses = graph.nodes
    .map((node): DerivedStatus => {
      const base = bases.get(node.id)!;
      const blockers = (blocksByTarget.get(node.id) ?? []).filter((edge) => {
        const blockerBase = bases.get(edge.from);
        return blockerBase !== undefined && !RESOLVED_BLOCKER_STATES.has(blockerBase.value);
      });
      if (blockers.length > 0 && base.value !== "achieved" && base.value !== "invalid") {
        return {
          subjectId: node.id,
          value: "blocked",
          policy: DERIVATION_POLICY,
          policyVersion: DERIVATION_POLICY_VERSION,
          rulesFired: [...base.rulesFired, "rule.blocked_by_unresolved_node"],
          sourceNodes: blockers.map((edge) => edge.from),
          sourceEdges: blockers.map((edge) => edge.id),
          sourceEvents: base.sourceEvents,
          unsatisfiedPrerequisites: blockers.map((edge) => `blocked by ${edge.from}`),
          limitations: base.limitations,
        };
      }
      return {
        subjectId: node.id,
        value: base.value,
        policy: DERIVATION_POLICY,
        policyVersion: DERIVATION_POLICY_VERSION,
        rulesFired: base.rulesFired,
        sourceNodes: base.sourceNodes,
        sourceEdges: base.sourceEdges,
        sourceEvents: base.sourceEvents,
        unsatisfiedPrerequisites: base.unsatisfiedPrerequisites,
        limitations: base.limitations,
      };
    })
    .toSorted((a, b) => byCodeUnit(a.subjectId, b.subjectId));

  const capabilityMaturity = (capability: WorkNode): CapabilityMaturity => {
    const requiresEdges = requiresBySource.get(capability.id) ?? [];
    const achievedTargets = requiresEdges.filter(
      (edge) => lifecycle.get(edge.to)?.state === "achieved",
    );
    const targetOfKind = (kinds: ReadonlyArray<string>) =>
      achievedTargets.filter((edge) => kinds.includes(nodesById.get(edge.to)?.kind ?? ""));

    const satisfied: Array<RungEvidence> = [];

    const researchEdges = graph.edges.filter(
      (edge) =>
        edge.kind === "derived_from" &&
        edge.from === capability.id &&
        nodesById.get(edge.to)?.kind === "research_question" &&
        lifecycle.get(edge.to)?.state === "achieved",
    );
    if (researchEdges.length > 0) {
      satisfied.push({
        rung: "researched",
        rule: "rule.maturity_research_concluded",
        sourceNodes: researchEdges.map((edge) => edge.to),
        sourceEdges: researchEdges.map((edge) => edge.id),
        sourceEvents: researchEdges.flatMap((edge) => {
          const fact = lifecycle.get(edge.to);
          return fact === undefined ? [] : [fact.event.id];
        }),
      });
    }

    const designEdges = targetOfKind(["design_contract"]);
    if (designEdges.length > 0) {
      satisfied.push({
        rung: "specified",
        rule: "rule.maturity_design_accepted",
        sourceNodes: designEdges.map((edge) => edge.to),
        sourceEdges: designEdges.map((edge) => edge.id),
        sourceEvents: designEdges.flatMap((edge) => {
          const fact = lifecycle.get(edge.to);
          return fact === undefined ? [] : [fact.event.id];
        }),
      });
    }

    const machineCheckedTargets = targetOfKind(["acceptance_gate", "work_item"]).filter((edge) => {
      const category: EvidenceCategory | undefined = lifecycle.get(edge.to)?.event.evidenceCategory;
      return category === "machine_check";
    });
    if (machineCheckedTargets.length > 0) {
      satisfied.push({
        rung: "executable_tracer_observed",
        rule: "rule.maturity_machine_checked_tracer",
        sourceNodes: machineCheckedTargets.map((edge) => edge.to),
        sourceEdges: machineCheckedTargets.map((edge) => edge.id),
        sourceEvents: machineCheckedTargets.flatMap((edge) => {
          const fact = lifecycle.get(edge.to);
          return fact === undefined ? [] : [fact.event.id];
        }),
      });
    }

    const observationRung = (
      rung: MaturityRung,
      rule: string,
      category: string,
    ): RungEvidence | undefined => {
      const edges = graph.edges.filter(
        (edge) =>
          edge.kind === "supports" &&
          edge.to === capability.id &&
          nodesById.get(edge.from)?.kind === "evidence" &&
          nodesById.get(edge.from)?.attributes?.["category"] === category &&
          lifecycle.get(edge.from)?.state === "achieved",
      );
      if (edges.length === 0) return undefined;
      return {
        rung,
        rule,
        sourceNodes: edges.map((edge) => edge.from),
        sourceEdges: edges.map((edge) => edge.id),
        sourceEvents: edges.flatMap((edge) => {
          const fact = lifecycle.get(edge.from);
          return fact === undefined ? [] : [fact.event.id];
        }),
      };
    };

    for (const [rung, rule, category] of [
      ["independently_reviewed", "rule.maturity_independent_review", "independent_review"],
      ["integrated", "rule.maturity_integration_observed", "integration_observation"],
      [
        "operationally_observed",
        "rule.maturity_operational_observation",
        "operational_observation",
      ],
    ] as const) {
      const evidence = observationRung(rung, rule, category);
      if (evidence !== undefined) satisfied.push(evidence);
    }

    const satisfiedRungNames = new Set(satisfied.map((entry) => entry.rung));
    const displayLevel =
      [...MATURITY_RUNGS]
        .toReversed()
        .find((rung) => rung !== "unexplored" && satisfiedRungNames.has(rung)) ?? "unexplored";

    return {
      capabilityId: capability.id,
      displayLevel,
      satisfiedRungs: satisfied,
      unsatisfiedRungs: MATURITY_RUNGS.filter(
        (rung) => rung !== "unexplored" && !satisfiedRungNames.has(rung),
      ),
      limitations: [
        "Each rung is satisfied only by its own typed evidence; a later rung does not imply an earlier one.",
      ],
    };
  };

  const capabilities = graph.nodes
    .filter((node) => node.kind === "capability")
    .map(capabilityMaturity)
    .toSorted((a, b) => byCodeUnit(a.capabilityId, b.capabilityId));

  const frontier = statuses
    .filter((status) => status.value === "available")
    .map((status) => status.subjectId);

  const unlocks = graph.nodes
    .map((node) => ({
      subjectId: node.id,
      unlocksSubjectIds: graph.edges
        .filter((edge) => edge.kind === "requires" && edge.to === node.id)
        .map((edge) => edge.from)
        .toSorted(byCodeUnit),
    }))
    .filter((entry) => entry.unlocksSubjectIds.length > 0)
    .toSorted((a, b) => byCodeUnit(a.subjectId, b.subjectId));

  return {
    policy: DERIVATION_POLICY,
    policyVersion: DERIVATION_POLICY_VERSION,
    statuses,
    prerequisites,
    capabilities,
    frontier,
    unlocks,
  };
};
