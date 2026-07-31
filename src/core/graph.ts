import type { LifecycleState, TransitionEvent, WorkEdge, WorkGraph, WorkNode } from "./model.ts";
import type { PolicyRegistry } from "./policy-registry.ts";
import { validateBasisReference, validateExactReference } from "./references.ts";
import { evaluateTransitionPolicy, type ValidatedTransitionEvidence } from "./transition-policy.ts";

export interface ValidationIssue {
  readonly code: string;
  readonly subject: string;
  readonly detail: string;
}

export interface ValidationResult {
  readonly accepted: boolean;
  readonly issues: ReadonlyArray<ValidationIssue>;
}

const duplicates = (values: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].toSorted();
};

const findCycle = (
  nodes: ReadonlyArray<WorkNode>,
  edges: ReadonlyArray<WorkEdge>,
  kind: "contains" | "requires",
): ReadonlyArray<string> | undefined => {
  const adjacency = new Map(nodes.map((node) => [node.id, [] as Array<string>]));
  for (const edge of edges) {
    if (edge.kind === kind) adjacency.get(edge.from)?.push(edge.to);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const trail: Array<string> = [];

  const visit = (nodeId: string): ReadonlyArray<string> | undefined => {
    if (visiting.has(nodeId)) {
      const start = trail.indexOf(nodeId);
      return [...trail.slice(start), nodeId];
    }
    if (visited.has(nodeId)) return undefined;

    visiting.add(nodeId);
    trail.push(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      const cycle = visit(next);
      if (cycle !== undefined) return cycle;
    }
    trail.pop();
    visiting.delete(nodeId);
    visited.add(nodeId);
    return undefined;
  };

  for (const node of nodes) {
    const cycle = visit(node.id);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
};

const correctionCycle = (
  event: TransitionEvent,
  events: ReadonlyMap<string, TransitionEvent>,
): boolean => {
  const seen = new Set<string>([event.id]);
  let targetId = event.supersedes;
  while (targetId !== undefined) {
    if (seen.has(targetId)) return true;
    seen.add(targetId);
    targetId = events.get(targetId)?.supersedes;
  }
  return false;
};

const correctionIssues = (
  graph: WorkGraph,
  events: ReadonlyMap<string, TransitionEvent>,
): ReadonlyArray<ValidationIssue> => {
  const issues: Array<ValidationIssue> = [];
  const positions = new Map(graph.events.map((event, index) => [event.id, index]));
  const correctorsByTarget = new Map<string, Array<string>>();

  for (const event of graph.events) {
    const isCorrection = event.transitionKind === "correct";
    if (isCorrection !== (event.supersedes !== undefined)) {
      issues.push({
        code: "correction_supersession_mismatch",
        subject: event.id,
        detail:
          "Transition kind 'correct' requires supersedes, and no other transition kind may supply it.",
      });
    }
    if (!isCorrection || event.supersedes === undefined) {
      if (event.basis.some((reference) => reference.kind === "graph_event")) {
        issues.push({
          code: "graph_event_basis_without_correction",
          subject: event.id,
          detail: "Graph-event basis references are reserved for explicit corrections.",
        });
      }
      continue;
    }

    correctorsByTarget.set(event.supersedes, [
      ...(correctorsByTarget.get(event.supersedes) ?? []),
      event.id,
    ]);
    const target = events.get(event.supersedes);
    const eventPosition = positions.get(event.id);
    const targetPosition = positions.get(event.supersedes);
    if (
      target === undefined ||
      target.subjectId !== event.subjectId ||
      eventPosition === undefined ||
      targetPosition === undefined ||
      targetPosition >= eventPosition
    ) {
      issues.push({
        code: "invalid_supersession",
        subject: event.id,
        detail:
          "A correction must supersede an earlier existing event for the same subject in append order.",
      });
    } else if (event.priorState !== target.priorState) {
      issues.push({
        code: "correction_prior_state_mismatch",
        subject: event.id,
        detail:
          "A correction replaces the target at its original position and must preserve that event's prior state.",
      });
    }

    const graphEventIds = event.basis.flatMap((reference) =>
      reference.kind === "graph_event" ? [reference.eventId] : [],
    );
    if (graphEventIds.length !== 1 || graphEventIds[0] !== event.supersedes) {
      issues.push({
        code: "correction_event_basis_mismatch",
        subject: event.id,
        detail:
          "A correction must contain exactly one graph-event basis naming the exact superseded event.",
      });
    }
    if (correctionCycle(event, events)) {
      issues.push({
        code: "correction_cycle",
        subject: event.id,
        detail: "Correction supersession chains must be acyclic.",
      });
    }
  }

  for (const [target, correctors] of correctorsByTarget) {
    if (correctors.length > 1) {
      for (const corrector of correctors) {
        issues.push({
          code: "competing_corrections",
          subject: corrector,
          detail: `Event ${target} has competing direct corrections: ${correctors.join(", ")}.`,
        });
      }
    }
  }
  return issues;
};

/**
 * Replays event history with each correction at the position of the event it
 * supersedes. Canonical array order is append order; `observedAt` is evidence,
 * never an ordering authority.
 */
export const effectiveEvents = (graph: WorkGraph): ReadonlyArray<TransitionEvent> => {
  const replacedBy = new Map<string, TransitionEvent>();
  for (const event of graph.events) {
    if (event.transitionKind === "correct" && event.supersedes !== undefined) {
      replacedBy.set(event.supersedes, event);
    }
  }
  const resolve = (event: TransitionEvent): TransitionEvent => {
    let current = event;
    const seen = new Set<string>();
    while (replacedBy.has(current.id) && !seen.has(current.id)) {
      seen.add(current.id);
      current = replacedBy.get(current.id)!;
    }
    return current;
  };
  return graph.events.filter((event) => event.transitionKind !== "correct").map(resolve);
};

/**
 * Evidence semantics for an event in an already accepted graph. Callers do
 * not derive labels from the event's free category string; the named policy
 * must resolve and validate its authority and bound evidence first.
 */
export const validatedTransitionEvidence = (
  graph: WorkGraph,
  event: TransitionEvent,
  registry: PolicyRegistry,
): ValidatedTransitionEvidence | undefined => {
  const node = graph.nodes.find((candidate) => candidate.id === event.subjectId);
  if (node === undefined) return undefined;
  if (event.basis.length === 0) return undefined;
  if (event.basis.some((reference) => validateBasisReference(reference).length > 0)) {
    return undefined;
  }
  return evaluateTransitionPolicy(event, node, registry).evidence;
};

export const validateGraph = (graph: WorkGraph, registry: PolicyRegistry): ValidationResult => {
  const issues: Array<ValidationIssue> = [];
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const events = new Map(graph.events.map((event) => [event.id, event]));

  for (const id of duplicates(graph.nodes.map((node) => node.id))) {
    issues.push({ code: "duplicate_node", subject: id, detail: `Duplicate node ${id}.` });
  }
  for (const id of duplicates(graph.edges.map((edge) => edge.id))) {
    issues.push({ code: "duplicate_edge", subject: id, detail: `Duplicate edge ${id}.` });
  }
  for (const id of duplicates(graph.events.map((event) => event.id))) {
    issues.push({ code: "duplicate_event", subject: id, detail: `Duplicate event ${id}.` });
  }
  for (const id of duplicates(graph.requests.map((request) => request.id))) {
    issues.push({ code: "duplicate_request", subject: id, detail: `Duplicate request ${id}.` });
  }
  for (const [kind, values] of [
    ["node", graph.nodes],
    ["edge", graph.edges],
    ["event", graph.events],
    ["request", graph.requests],
  ] as const) {
    for (const value of values) {
      if (value.id.length === 0) {
        issues.push({
          code: `empty_${kind}_id`,
          subject: "$",
          detail: `Canonical ${kind} identifiers must not be empty.`,
        });
      }
    }
  }

  for (const node of graph.nodes) {
    if (node.exactSubject !== undefined) {
      for (const problem of validateExactReference(node.exactSubject)) {
        issues.push({
          code: problem,
          subject: node.id,
          detail: `Node ${node.id} has an invalid exact subject.`,
        });
      }
    }
    if (node.evidenceRole !== undefined && node.kind !== "evidence") {
      issues.push({
        code: "evidence_role_on_non_evidence_node",
        subject: node.id,
        detail: "Only evidence nodes may carry a typed evidence role.",
      });
    }
  }

  for (const request of graph.requests) {
    if (!nodes.has(request.subjectId)) {
      issues.push({
        code: "missing_request_subject",
        subject: request.id,
        detail: `Request ${request.id} references missing subject ${request.subjectId}.`,
      });
    }
    if (request.declaredInRepository.length === 0) {
      issues.push({
        code: "empty_request_repository",
        subject: request.id,
        detail: `Request ${request.id} requires a canonical repository identity.`,
      });
    }
  }

  for (const edge of graph.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      issues.push({
        code: "dangling_edge",
        subject: edge.id,
        detail: `Edge ${edge.id} references a missing endpoint.`,
      });
    }
    if (
      edge.kind === "requires" &&
      edge.attributes?.["optional"] === true &&
      typeof edge.attributes?.["orGroup"] === "string"
    ) {
      issues.push({
        code: "ambiguous_optional_or_prerequisite",
        subject: edge.id,
        detail: "A requires edge cannot be both optional and an OR-group alternative.",
      });
    }
  }

  for (const kind of ["contains", "requires"] as const) {
    const cycle = findCycle(graph.nodes, graph.edges, kind);
    if (cycle !== undefined) {
      issues.push({
        code: `${kind}_cycle`,
        subject: cycle[0]!,
        detail: `${kind} cycle: ${cycle.join(" -> ")}`,
      });
    }
  }

  issues.push(...correctionIssues(graph, events));

  for (const event of graph.events) {
    const node = nodes.get(event.subjectId);
    if (node === undefined) {
      issues.push({
        code: "missing_transition_subject",
        subject: event.id,
        detail: `Transition ${event.id} references missing subject ${event.subjectId}.`,
      });
      continue;
    }

    if (event.basis.length === 0) {
      issues.push({
        code: "empty_transition_basis",
        subject: event.id,
        detail: "Every transition requires a nonempty exact basis.",
      });
    }
    for (const [code, value, field] of [
      ["empty_transition_actor", event.actor, "actor"],
      ["empty_transition_rationale", event.rationale, "rationale"],
      ["empty_transition_observation_time", event.observedAt, "observedAt"],
    ] as const) {
      if (value.length === 0) {
        issues.push({
          code,
          subject: event.id,
          detail: `Transition ${event.id} requires a nonempty ${field}.`,
        });
      }
    }
    const basisProblems = event.basis.flatMap((reference) => validateBasisReference(reference));
    for (const problem of basisProblems) {
      issues.push({
        code: problem,
        subject: event.id,
        detail: `Transition ${event.id} contains a non-exact ${problem} basis reference.`,
      });
    }
    if (
      event.basis.length > 0 &&
      !event.basis.some((reference) => validateBasisReference(reference).length === 0)
    ) {
      issues.push({
        code: "transition_without_exact_reference",
        subject: event.id,
        detail: "No transition basis reference satisfies its frozen exactness contract.",
      });
    }

    if (event.fulfillsRequest !== undefined) {
      const request = graph.requests.find((candidate) => candidate.id === event.fulfillsRequest);
      if (
        request === undefined ||
        request.subjectId !== event.subjectId ||
        request.requestedState !== event.requestedState
      ) {
        issues.push({
          code: "invalid_request_fulfillment",
          subject: event.id,
          detail: "A fulfilling event must match an existing request subject and state.",
        });
      }
      const observedCommits = event.basis.filter((reference) => reference.kind === "git_commit");
      if (observedCommits.length === 0) {
        issues.push({
          code: "request_fulfillment_without_commit",
          subject: event.id,
          detail:
            "Fulfilling a commit-declared request requires observing the immutable resulting commit.",
        });
      } else if (
        request !== undefined &&
        !observedCommits.some((reference) => reference.repository === request.declaredInRepository)
      ) {
        issues.push({
          code: "request_fulfillment_repository_mismatch",
          subject: event.id,
          detail:
            "The exact Git commit fulfilling a request must use the request's declared canonical repository identity.",
        });
      }
    }

    for (const policyIssue of evaluateTransitionPolicy(event, node, registry).issues) {
      issues.push({
        code: policyIssue.code,
        subject: event.id,
        detail: policyIssue.detail,
      });
    }
  }

  const latestState = new Map<string, LifecycleState>();
  for (const event of effectiveEvents(graph)) {
    const current = latestState.get(event.subjectId) ?? null;
    if (event.priorState !== current) {
      issues.push({
        code: "prior_state_mismatch",
        subject: event.id,
        detail: `Effective append-order replay expected prior state ${String(current)}, received ${String(event.priorState)}.`,
      });
    }
    latestState.set(event.subjectId, event.requestedState);
  }

  return { accepted: issues.length === 0, issues };
};

export const reduceLifecycle = (
  graph: WorkGraph,
): ReadonlyMap<string, LifecycleState | "locked"> => {
  const state = new Map<string, LifecycleState | "locked">(
    graph.nodes.map((node) => [node.id, "locked"]),
  );
  for (const event of effectiveEvents(graph)) {
    state.set(event.subjectId, event.requestedState);
  }
  return state;
};
