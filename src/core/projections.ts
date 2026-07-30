import type { BasisReference, TransitionEvent, WorkGraph } from "./model.ts";
import type { Derivation, DerivedStatus } from "./derive.ts";
import { validateGraph } from "./graph.ts";
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

const explainEvent = (event: TransitionEvent): Readonly<Record<string, unknown>> => ({
  id: event.id,
  subjectId: event.subjectId,
  priorState: event.priorState,
  requestedState: event.requestedState,
  transitionKind: event.transitionKind,
  actor: event.actor,
  authority: event.authority,
  evidenceCategory: event.evidenceCategory,
  machineChecked: event.evidenceCategory === "machine_check",
  humanApprovedAssertion: event.evidenceCategory === "human_approved_assertion",
  policy: event.policy,
  policyVersion: event.policyVersion,
  rationale: event.rationale,
  observedAt: event.observedAt,
  basis: event.basis.map(basisSummary),
  ...(event.supersedes === undefined ? {} : { supersedes: event.supersedes }),
  ...(event.fulfillsRequest === undefined ? {} : { fulfillsRequest: event.fulfillsRequest }),
});

interface ScheduleEntry {
  readonly subjectId: string;
  readonly title: string;
  readonly kind: string;
  readonly derivedValue: string;
  readonly dependsOn: ReadonlyArray<{ readonly targetId: string; readonly orGroup?: string }>;
  readonly layer: number;
}

const dependencySchedule = (
  graph: WorkGraph,
  statusById: ReadonlyMap<string, DerivedStatus>,
): { readonly ok: true; readonly entries: ReadonlyArray<ScheduleEntry> } | ProjectionFailure => {
  const requiresEdges = graph.edges.filter((edge) => edge.kind === "requires");
  const participantIds = [
    ...new Set(requiresEdges.flatMap((edge) => [edge.from, edge.to])),
  ].toSorted(byCodeUnit);

  const layers = new Map<string, number>();
  const layerOf = (id: string, trail: ReadonlyArray<string>): number | undefined => {
    if (trail.includes(id)) return undefined;
    const known = layers.get(id);
    if (known !== undefined) return known;
    const dependencies = requiresEdges.filter((edge) => edge.from === id);
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
  const entries = participantIds.map((id): ScheduleEntry => {
    const node = nodesById.get(id);
    return {
      subjectId: id,
      title: node?.title ?? id,
      kind: node?.kind ?? "unknown",
      derivedValue: statusById.get(id)?.value ?? "invalid",
      dependsOn: requiresEdges
        .filter((edge) => edge.from === id)
        .map((edge) => {
          const orGroup = edge.attributes?.["orGroup"];
          return typeof orGroup === "string"
            ? { targetId: edge.to, orGroup }
            : { targetId: edge.to };
        })
        .toSorted((a, b) => byCodeUnit(a.targetId, b.targetId)),
      layer: layers.get(id) ?? 0,
    };
  });
  return { ok: true, entries };
};

const mermaidId = (id: string): string => id.replaceAll(/[^A-Za-z0-9]/gu, "_");

const mermaidRoadmap = (
  graph: WorkGraph,
  derivation: Derivation,
  canonicalDigest: string,
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
    graph.events
      .filter((event) => event.evidenceCategory === "human_approved_assertion")
      .map((event) => event.subjectId),
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
    lines.push(
      typeof orGroup === "string"
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
): string => {
  const statusById = new Map(derivation.statuses.map((status) => [status.subjectId, status]));
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const achievingEvent = new Map<string, TransitionEvent>();
  for (const event of graph.events) achievingEvent.set(event.subjectId, event);

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
      const authorityNote =
        event === undefined
          ? "no canonical transition"
          : event.evidenceCategory === "human_approved_assertion"
            ? "human-approved assertion; machine_checked: false"
            : event.evidenceCategory === "machine_check"
              ? "machine-checked against its exact subject"
              : `recorded as ${event.evidenceCategory}`;
      lines.push(
        `| ${node?.title ?? member.to} | ${node?.kind ?? "unknown"} | ${
          memberStatus?.value ?? "invalid"
        } | ${event?.evidenceCategory ?? "none"} | ${authorityNote} |`,
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
): ProjectionOutcome => {
  const validation = validateGraph(graph);
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
  const schedule = dependencySchedule(graph, statusById);
  if (!("ok" in schedule)) return { ok: false, failure: schedule };

  const fulfilledRequestIds = new Set(
    graph.events.flatMap((event) =>
      event.fulfillsRequest === undefined ? [] : [event.fulfillsRequest],
    ),
  );

  const roadmap = {
    canonicalDigest: `sha256:${canonicalDigest}`,
    generator: PROJECTION_GENERATOR,
    policy: derivation.policy,
    policyVersion: derivation.policyVersion,
    frontier: derivation.frontier,
    capabilities: derivation.capabilities.map((capability) => ({
      capabilityId: capability.capabilityId,
      title:
        graph.nodes.find((node) => node.id === capability.capabilityId)?.title ??
        capability.capabilityId,
      derivedValue: statusById.get(capability.capabilityId)?.value ?? "invalid",
      maturity: capability,
      prerequisites:
        derivation.prerequisites.find((report) => report.subjectId === capability.capabilityId) ??
        null,
      derivedStatus: statusById.get(capability.capabilityId) ?? null,
    })),
    unlocks: derivation.unlocks,
    limitations: [
      "Derived values are projections of accepted canonical events; they are not proofs.",
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
    events: graph.events.map(explainEvent),
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
      { path: "normalized-graph.json", content: stableStringify(graph) },
      { path: "capability-roadmap.json", content: stableStringify(roadmap) },
      {
        path: "capability-roadmap.mmd",
        content: mermaidRoadmap(graph, derivation, canonicalDigest),
      },
      { path: "dependency-schedule.json", content: stableStringify(scheduleView) },
      {
        path: "milestone-status.md",
        content: milestoneMarkdown(graph, derivation, canonicalDigest),
      },
      { path: "transition-explanations.json", content: stableStringify(explanation) },
    ],
  };
};
