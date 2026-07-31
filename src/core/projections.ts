import type {
  AuthorityKind,
  BasisReference,
  EvidenceCategory,
  TransitionEvent,
  WorkGraph,
} from "./model.ts";
import type { PolicyRegistry } from "./policy-registry.ts";
import type { Derivation, DerivedStatus } from "./derive.ts";
import { effectiveEvents, validateGraph, validatedTransitionEvidence } from "./graph.ts";
import { stableStringify } from "./normalize.ts";

export const PROJECTION_GENERATOR = "workgraph-tracer-0001-projector/1";

export interface ProjectionFile {
  readonly path: string;
  readonly content: string;
}

export interface ProjectionFailure {
  readonly code: "graph_rejected" | "requires_cycle";
  readonly detail: string;
}

export type ProjectionOutcome =
  | { readonly ok: true; readonly files: ReadonlyArray<ProjectionFile> }
  | { readonly ok: false; readonly failure: ProjectionFailure };

const byCodeUnit = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const basisSummary = (reference: BasisReference): Readonly<Record<string, unknown>> => {
  switch (reference.kind) {
    case "git_commit":
      return {
        kind: reference.kind,
        repository: reference.repository,
        objectFormat: reference.objectFormat,
        objectId: reference.objectId,
        ...(reference.path === undefined ? {} : { path: reference.path }),
        ...(reference.mutableContext === undefined
          ? {}
          : { mutableContextOnly: reference.mutableContext }),
      };
    case "artifact":
      return {
        kind: reference.kind,
        algorithm: reference.algorithm,
        digest: reference.digest,
        mediaType: reference.mediaType,
      };
    case "machine_check":
      return {
        kind: reference.kind,
        checker: reference.checker,
        checkerVersion: reference.checkerVersion,
        policy: reference.policy,
        operation: reference.operation,
        result: reference.result,
        exitCode: reference.exitCode,
        subjects: reference.subjects.map(basisSummary),
        outputDigest: reference.output.digest,
        observedAt: reference.observedAt,
      };
    case "external_record":
      return {
        kind: reference.kind,
        provider: reference.provider,
        project: reference.project,
        recordId: reference.recordId,
        observedVersion: reference.observedVersion,
        observedAt: reference.observedAt,
        interpretation: reference.interpretation,
      };
    case "human_approval":
      return {
        kind: reference.kind,
        actor: reference.actor,
        authentication: reference.authentication,
        authorityScope: reference.authorityScope,
        approvedTransition: reference.approvedTransition,
        evidenceCategory: reference.evidenceCategory,
        machineChecked: reference.machineChecked,
        approvedAt: reference.approvedAt,
        subjects: reference.subjects.map(basisSummary),
      };
    case "graph_event":
      return { kind: reference.kind, eventId: reference.eventId };
  }
};

const explainEvent = (
  graph: WorkGraph,
  event: TransitionEvent,
  registry: PolicyRegistry,
): Readonly<Record<string, unknown>> => {
  const evidence = validatedTransitionEvidence(graph, event, registry);
  return {
    id: event.id,
    subjectId: event.subjectId,
    priorState: event.priorState,
    requestedState: event.requestedState,
    transitionKind: event.transitionKind,
    actor: event.actor,
    authority: event.authority,
    declaredEvidenceCategory: event.evidenceCategory,
    evidenceCategory: evidence?.category ?? "invalid",
    machineChecked: evidence?.machineChecked ?? false,
    humanApprovedAssertion: evidence?.humanApprovedAssertion ?? false,
    policy: event.policy,
    policyVersion: event.policyVersion,
    policyRulesFired: evidence?.rulesFired ?? [],
    rationale: event.rationale,
    observedAt: event.observedAt,
    basis: event.basis.map(basisSummary),
    ...(event.supersedes === undefined ? {} : { supersedes: event.supersedes }),
    ...(event.fulfillsRequest === undefined ? {} : { fulfillsRequest: event.fulfillsRequest }),
  };
};

interface TransitionEvidenceSummary {
  readonly eventId: string;
  readonly authority: AuthorityKind;
  readonly evidenceCategory: EvidenceCategory;
  readonly machineChecked: boolean;
  readonly humanApprovedAssertion: boolean;
}

const effectiveEvidenceBySubject = (
  graph: WorkGraph,
  registry: PolicyRegistry,
): ReadonlyMap<string, TransitionEvidenceSummary> => {
  const summaries = new Map<string, TransitionEvidenceSummary>();
  for (const event of effectiveEvents(graph)) {
    const evidence = validatedTransitionEvidence(graph, event, registry);
    if (evidence === undefined) continue;
    summaries.set(event.subjectId, {
      eventId: event.id,
      authority: evidence.authority,
      evidenceCategory: evidence.category,
      machineChecked: evidence.machineChecked,
      humanApprovedAssertion: evidence.humanApprovedAssertion,
    });
  }
  return summaries;
};

interface ScheduleEntry {
  readonly subjectId: string;
  readonly title: string;
  readonly kind: string;
  readonly derivedValue: string;
  readonly dependsOn: ReadonlyArray<{
    readonly targetId: string;
    readonly orGroup?: string;
    readonly optional?: true;
    readonly transitionEvidence?: TransitionEvidenceSummary;
  }>;
  readonly transitionEvidence?: TransitionEvidenceSummary;
  readonly layer: number;
}

const dependencySchedule = (
  graph: WorkGraph,
  statusById: ReadonlyMap<string, DerivedStatus>,
  registry: PolicyRegistry,
): { readonly ok: true; readonly entries: ReadonlyArray<ScheduleEntry> } | ProjectionFailure => {
  const requiresEdges = graph.edges.filter((edge) => edge.kind === "requires");
  const schedulingEdges = requiresEdges.filter((edge) => edge.attributes?.["optional"] !== true);
  const participantIds = [
    ...new Set(requiresEdges.flatMap((edge) => [edge.from, edge.to])),
  ].toSorted(byCodeUnit);

  const layers = new Map<string, number>();
  const layerOf = (id: string, trail: ReadonlyArray<string>): number | undefined => {
    if (trail.includes(id)) return undefined;
    const known = layers.get(id);
    if (known !== undefined) return known;
    const dependencies = schedulingEdges.filter((edge) => edge.from === id);
    let layer = 0;
    for (const edge of dependencies) {
      const dependencyLayer = layerOf(edge.to, [...trail, id]);
      if (dependencyLayer === undefined) return undefined;
      layer = Math.max(layer, dependencyLayer + 1);
    }
    layers.set(id, layer);
    return layer;
  };

  for (const id of participantIds) {
    if (layerOf(id, []) === undefined) {
      return {
        code: "requires_cycle",
        detail: `The dependency schedule requires acyclic 'requires' edges; a cycle involves ${id}.`,
      };
    }
  }

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const evidenceBySubject = effectiveEvidenceBySubject(graph, registry);
  const entries = participantIds.map((id): ScheduleEntry => {
    const node = nodesById.get(id);
    const transitionEvidence = evidenceBySubject.get(id);
    const entry: ScheduleEntry = {
      subjectId: id,
      title: node?.title ?? id,
      kind: node?.kind ?? "unknown",
      derivedValue: statusById.get(id)?.value ?? "invalid",
      dependsOn: requiresEdges
        .filter((edge) => edge.from === id)
        .map((edge) => {
          const orGroup = edge.attributes?.["orGroup"];
          const optional = edge.attributes?.["optional"] === true;
          const dependencyEvidence = evidenceBySubject.get(edge.to);
          const dependency: ScheduleEntry["dependsOn"][number] = {
            targetId: edge.to,
          };
          if (optional) Object.assign(dependency, { optional: true as const });
          if (typeof orGroup === "string") Object.assign(dependency, { orGroup });
          if (dependencyEvidence !== undefined) {
            Object.assign(dependency, { transitionEvidence: dependencyEvidence });
          }
          return dependency;
        })
        .toSorted((a, b) => byCodeUnit(a.targetId, b.targetId)),
      layer: layers.get(id) ?? 0,
    };
    if (transitionEvidence !== undefined) {
      Object.assign(entry, { transitionEvidence });
    }
    return entry;
  });
  return { ok: true, entries };
};

const mermaidId = (id: string): string => id.replaceAll(/[^A-Za-z0-9]/gu, "_");

const mermaidRoadmap = (
  graph: WorkGraph,
  derivation: Derivation,
  canonicalDigest: string,
  registry: PolicyRegistry,
): string => {
  const statusById = new Map(derivation.statuses.map((status) => [status.subjectId, status]));
  const maturityById = new Map(
    derivation.capabilities.map((capability) => [capability.capabilityId, capability]),
  );
  const requiresEdges = graph.edges.filter((edge) => edge.kind === "requires");
  const includeIds = [
    ...new Set([
      ...graph.nodes.filter((node) => node.kind === "capability").map((node) => node.id),
      ...graph.nodes.filter((node) => node.kind === "milestone").map((node) => node.id),
      ...requiresEdges.flatMap((edge) => [edge.from, edge.to]),
    ]),
  ].toSorted(byCodeUnit);
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const humanApprovedSubjects = new Set(
    [...effectiveEvidenceBySubject(graph, registry)]
      .filter(([, evidence]) => evidence.humanApprovedAssertion)
      .map(([subjectId]) => subjectId),
  );

  const lines: Array<string> = [
    `%% generated by ${PROJECTION_GENERATOR}`,
    `%% canonicalDigest: sha256:${canonicalDigest}`,
    "%% derived view; never edit by hand",
    "flowchart TD",
  ];
  for (const id of includeIds) {
    const node = nodesById.get(id);
    if (node === undefined) continue;
    const status = statusById.get(id)?.value ?? "invalid";
    const maturity = maturityById.get(id);
    const labelParts = [
      node.title,
      `derived: ${status}`,
      ...(maturity === undefined ? [] : [`maturity: ${maturity.displayLevel}`]),
      ...(humanApprovedSubjects.has(id)
        ? ["human-approved assertion, machine_checked: false"]
        : []),
    ];
    lines.push(`  ${mermaidId(id)}["${labelParts.join("<br/>")}"]:::${status}`);
  }
  for (const edge of requiresEdges.toSorted((a, b) => byCodeUnit(a.id, b.id))) {
    const orGroup = edge.attributes?.["orGroup"];
    const optional = edge.attributes?.["optional"] === true;
    lines.push(
      optional
        ? `  ${mermaidId(edge.from)} -. "optional branch (non-blocking)" .-> ${mermaidId(edge.to)}`
        : typeof orGroup === "string"
          ? `  ${mermaidId(edge.from)} -. "requires (or: ${orGroup})" .-> ${mermaidId(edge.to)}`
          : `  ${mermaidId(edge.from)} -- requires --> ${mermaidId(edge.to)}`,
    );
  }
  for (const edge of graph.edges
    .filter((element) => element.kind === "contains")
    .filter((element) => includeIds.includes(element.from) && includeIds.includes(element.to))
    .toSorted((a, b) => byCodeUnit(a.id, b.id))) {
    lines.push(`  ${mermaidId(edge.from)} -. contains .-> ${mermaidId(edge.to)}`);
  }
  lines.push(
    "  classDef locked fill:#e2e8f0,stroke:#64748b",
    "  classDef available fill:#dcfce7,stroke:#16a34a",
    "  classDef active fill:#dbeafe,stroke:#2563eb",
    "  classDef waiting fill:#fef9c3,stroke:#ca8a04",
    "  classDef blocked fill:#fee2e2,stroke:#dc2626",
    "  classDef achieved fill:#bbf7d0,stroke:#15803d",
    "  classDef stale fill:#fde68a,stroke:#b45309",
    "  classDef invalid fill:#fecaca,stroke:#991b1b",
  );
  return `${lines.join("\n")}\n`;
};

const milestoneMarkdown = (
  graph: WorkGraph,
  derivation: Derivation,
  canonicalDigest: string,
  registry: PolicyRegistry,
): string => {
  const statusById = new Map(derivation.statuses.map((status) => [status.subjectId, status]));
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const achievingEvent = new Map<string, TransitionEvent>();
  for (const event of effectiveEvents(graph)) achievingEvent.set(event.subjectId, event);

  const lines: Array<string> = [
    "# Milestone status",
    "",
    `Generated by ${PROJECTION_GENERATOR} from canonical digest \`sha256:${canonicalDigest}\`.`,
    "This file is a derived view; never edit it by hand.",
    "",
  ];

  for (const milestone of graph.nodes
    .filter((node) => node.kind === "milestone")
    .toSorted((a, b) => byCodeUnit(a.id, b.id))) {
    const status = statusById.get(milestone.id);
    lines.push(
      `## ${milestone.title}`,
      "",
      `Derived state: **${status?.value ?? "invalid"}** (rules: ${
        status?.rulesFired.join(", ") ?? "none"
      })`,
      "",
      "| Member | Kind | Derived | Latest evidence category | Authority note |",
      "| --- | --- | --- | --- | --- |",
    );
    const members = graph.edges
      .filter((edge) => edge.kind === "contains" && edge.from === milestone.id)
      .toSorted((a, b) => byCodeUnit(a.to, b.to));
    for (const member of members) {
      const node = nodesById.get(member.to);
      const memberStatus = statusById.get(member.to);
      const event = achievingEvent.get(member.to);
      const evidence =
        event === undefined ? undefined : validatedTransitionEvidence(graph, event, registry);
      // "machine-checked against its exact subject" is claimed only for
      // machine_policy authority, where the validator enforces that a passing
      // check itself names the subject's exact reference.
      const authorityNote =
        event === undefined
          ? "no canonical transition"
          : evidence?.humanApprovedAssertion === true
            ? "human-approved assertion; machine_checked: false"
            : evidence?.machineChecked === true
              ? "machine-checked against its exact subject"
              : `recorded as ${evidence?.category ?? "invalid"}`;
      lines.push(
        `| ${node?.title ?? member.to} | ${node?.kind ?? "unknown"} | ${
          memberStatus?.value ?? "invalid"
        } | ${evidence?.category ?? "none"} | ${authorityNote} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Frontier (available now)", "");
  for (const id of derivation.frontier) {
    lines.push(`- ${nodesById.get(id)?.title ?? id} (\`${id}\`)`);
  }
  lines.push("", "## Attention (stale or blocked)", "");
  for (const status of derivation.statuses.filter(
    (entry) => entry.value === "stale" || entry.value === "blocked",
  )) {
    lines.push(
      `- ${nodesById.get(status.subjectId)?.title ?? status.subjectId} (\`${status.subjectId}\`): ${
        status.value
      } — rules ${status.rulesFired.join(", ")}; sources ${
        [...status.sourceNodes, ...status.sourceEdges].join(", ") || "none"
      }`,
    );
  }
  lines.push("");
  return lines.join("\n");
};

export const projectAll = (
  graph: WorkGraph,
  derivation: Derivation,
  canonicalDigest: string,
  registry: PolicyRegistry,
): ProjectionOutcome => {
  const validation = validateGraph(graph, registry);
  if (!validation.accepted) {
    return {
      ok: false,
      failure: {
        code: "graph_rejected",
        detail: validation.issues
          .map((issue) => `${issue.code}(${issue.subject})`)
          .toSorted(byCodeUnit)
          .join("; "),
      },
    };
  }

  const statusById = new Map(derivation.statuses.map((status) => [status.subjectId, status]));
  const schedule = dependencySchedule(graph, statusById, registry);
  if (!("ok" in schedule)) return { ok: false, failure: schedule };

  const fulfilledRequestIds = new Set(
    graph.events.flatMap((event) =>
      event.fulfillsRequest === undefined ? [] : [event.fulfillsRequest],
    ),
  );
  const evidenceBySubject = effectiveEvidenceBySubject(graph, registry);
  const evidenceByEvent = new Map(
    [...evidenceBySubject.values()].map((evidence) => [evidence.eventId, evidence]),
  );
  const sourceTransitionEvidence = (
    eventIds: ReadonlyArray<string>,
  ): ReadonlyArray<TransitionEvidenceSummary> =>
    eventIds.flatMap((eventId) => {
      const evidence = evidenceByEvent.get(eventId);
      return evidence === undefined ? [] : [evidence];
    });
  const withTransitionEvidence = <T extends { readonly targetId: string }>(
    prerequisite: T,
  ): T & { readonly transitionEvidence?: TransitionEvidenceSummary } => {
    const transitionEvidence = evidenceBySubject.get(prerequisite.targetId);
    return {
      ...prerequisite,
      ...(transitionEvidence === undefined ? {} : { transitionEvidence }),
    };
  };

  const roadmap = {
    canonicalDigest: `sha256:${canonicalDigest}`,
    generator: PROJECTION_GENERATOR,
    policy: derivation.policy,
    policyVersion: derivation.policyVersion,
    frontier: derivation.frontier,
    capabilities: derivation.capabilities.map((capability) => {
      const prerequisites = derivation.prerequisites.find(
        (report) => report.subjectId === capability.capabilityId,
      );
      const transitionEvidence = evidenceBySubject.get(capability.capabilityId);
      const derivedStatus = statusById.get(capability.capabilityId);
      return {
        capabilityId: capability.capabilityId,
        title:
          graph.nodes.find((node) => node.id === capability.capabilityId)?.title ??
          capability.capabilityId,
        derivedValue: statusById.get(capability.capabilityId)?.value ?? "invalid",
        maturity: {
          ...capability,
          satisfiedRungs: capability.satisfiedRungs.map((rung) => ({
            ...rung,
            sourceTransitionEvidence: sourceTransitionEvidence(rung.sourceEvents),
          })),
        },
        prerequisites:
          prerequisites === undefined
            ? null
            : {
                ...prerequisites,
                andPrerequisites: prerequisites.andPrerequisites.map(withTransitionEvidence),
                orGroups: prerequisites.orGroups.map((group) => ({
                  ...group,
                  alternatives: group.alternatives.map(withTransitionEvidence),
                })),
                optionalPrerequisites:
                  prerequisites.optionalPrerequisites.map(withTransitionEvidence),
              },
        ...(transitionEvidence === undefined ? {} : { transitionEvidence }),
        derivedStatus:
          derivedStatus === undefined
            ? null
            : {
                ...derivedStatus,
                sourceTransitionEvidence: sourceTransitionEvidence(derivedStatus.sourceEvents),
              },
      };
    }),
    unlocks: derivation.unlocks,
    limitations: [
      "Derived values are projections of accepted canonical events; they claim nothing beyond their sources.",
      "Human-approved transitions remain human-approved assertions in every view.",
    ],
  };

  const scheduleView = {
    canonicalDigest: `sha256:${canonicalDigest}`,
    generator: PROJECTION_GENERATOR,
    edgeKinds: ["requires"],
    note: "This schedule is a derived acyclic projection, not the canonical graph.",
    entries: schedule.entries,
  };

  const explanation = {
    canonicalDigest: `sha256:${canonicalDigest}`,
    generator: PROJECTION_GENERATOR,
    derivationPolicy: { policy: derivation.policy, policyVersion: derivation.policyVersion },
    events: graph.events.map((event) => explainEvent(graph, event, registry)),
    effectiveEventIds: effectiveEvents(graph).map((event) => event.id),
    pendingRequests: graph.requests
      .filter((request) => !fulfilledRequestIds.has(request.id))
      .map((request) => ({
        id: request.id,
        subjectId: request.subjectId,
        requestedState: request.requestedState,
        declaredBy: request.declaredBy,
        declaredInRepository: request.declaredInRepository,
        rationale: request.rationale,
        canonicalEffect:
          "none: a commit-declared request changes no state until an observer event references the immutable resulting commit",
      })),
    derivedStatuses: derivation.statuses,
  };

  return {
    ok: true,
    files: [
      {
        path: "normalized-graph.json",
        content: stableStringify({
          canonicalDigest: `sha256:${canonicalDigest}`,
          digestScope:
            "sha256 of the deterministic canonicalGraph serialization; not a hash of this wrapper",
          generator: PROJECTION_GENERATOR,
          canonicalGraph: graph,
        }),
      },
      { path: "capability-roadmap.json", content: stableStringify(roadmap) },
      {
        path: "capability-roadmap.mmd",
        content: mermaidRoadmap(graph, derivation, canonicalDigest, registry),
      },
      { path: "dependency-schedule.json", content: stableStringify(scheduleView) },
      {
        path: "milestone-status.md",
        content: milestoneMarkdown(graph, derivation, canonicalDigest, registry),
      },
      { path: "transition-explanations.json", content: stableStringify(explanation) },
    ],
  };
};
