import type {
  BasisReference,
  LifecycleState,
  TransitionEvent,
  WorkEdge,
  WorkGraph,
  WorkNode,
} from "./model.ts";
import { sameExactReference, validateExactReference } from "./references.ts";

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

const exactReferencesFromBasis = (
  basis: ReadonlyArray<BasisReference>,
): ReadonlyArray<ReturnType<typeof extractExactReference>> =>
  basis.flatMap((reference) => {
    if (reference.kind === "git_commit" || reference.kind === "artifact") return [reference];
    if (reference.kind === "machine_check" || reference.kind === "human_approval") {
      return reference.subjects;
    }
    return [];
  });

const extractExactReference = (reference: BasisReference) => {
  if (reference.kind === "git_commit" || reference.kind === "artifact") return reference;
  return undefined;
};

const validateTransitionPolicy = (
  event: TransitionEvent,
  node: WorkNode,
): ReadonlyArray<ValidationIssue> => {
  const issues: Array<ValidationIssue> = [];

  for (const reference of exactReferencesFromBasis(event.basis)) {
    if (reference === undefined) continue;
    for (const problem of validateExactReference(reference)) {
      issues.push({
        code: problem,
        subject: event.id,
        detail: `Invalid exact reference in transition ${event.id}.`,
      });
    }
  }

  if (event.authority === "machine_policy") {
    const checks = event.basis.filter((reference) => reference.kind === "machine_check");
    const passing = checks.filter((check) => check.result === "passed" && check.exitCode === 0);
    if (event.evidenceCategory !== "machine_check" || checks.length === 0) {
      issues.push({
        code: "machine_policy_without_check",
        subject: event.id,
        detail: "Machine-policy transitions require machine-check evidence.",
      });
    } else if (passing.length === 0) {
      issues.push({
        code: "machine_check_not_passing",
        subject: event.id,
        detail: "At least one bound machine check must pass.",
      });
    } else if (node.exactSubject === undefined) {
      issues.push({
        code: "machine_policy_unbound_subject",
        subject: event.id,
        detail:
          "A machine-policy transition requires the subject node to declare an exact subject identity for the check to bind to.",
      });
    } else if (
      !passing.some((check) =>
        check.subjects.some((subject) => sameExactReference(subject, node.exactSubject!)),
      )
    ) {
      // Conjoint binding: a passing check and a matching exact reference in
      // the basis are not enough independently. The passing check itself must
      // name the subject's exact reference, or a check for commit A padded
      // with a bare reference to commit B could unlock B.
      issues.push({
        code: "machine_check_not_bound_to_subject",
        subject: event.id,
        detail:
          "No passing machine check names the subject's exact reference; a check for a different subject cannot unlock this node.",
      });
    }
  }

  if (event.authority === "human_approval") {
    const approvals = event.basis.filter((reference) => reference.kind === "human_approval");
    const wellFormed = approvals.filter(
      (approval) =>
        approval.approvedTransition === event.requestedState && approval.machineChecked === false,
    );
    if (event.evidenceCategory !== "human_approved_assertion" || wellFormed.length === 0) {
      issues.push({
        code: "human_approval_mislabeled",
        subject: event.id,
        detail: "Human authority requires an explicitly non-machine-checked approval.",
      });
    } else if (node.exactSubject === undefined) {
      issues.push({
        code: "human_approval_unbound_subject",
        subject: event.id,
        detail:
          "A human-approval transition requires the subject node to declare an exact subject identity for the approval to bind to.",
      });
    } else if (
      !wellFormed.some((approval) =>
        approval.subjects.some((subject) => sameExactReference(subject, node.exactSubject!)),
      )
    ) {
      issues.push({
        code: "human_approval_not_bound_to_subject",
        subject: event.id,
        detail:
          "No qualifying approval names the subject's exact reference; an approval about a different artifact cannot advance this node.",
      });
    }
  }

  if (node.exactSubject !== undefined) {
    const bound = exactReferencesFromBasis(event.basis).some(
      (reference) => reference !== undefined && sameExactReference(reference, node.exactSubject!),
    );
    if (!bound) {
      issues.push({
        code: "exact_subject_mismatch",
        subject: event.id,
        detail: "Transition evidence is not bound to the subject's exact reference.",
      });
    }
  }

  return issues;
};

export const validateGraph = (graph: WorkGraph): ValidationResult => {
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

  for (const request of graph.requests) {
    if (!nodes.has(request.subjectId)) {
      issues.push({
        code: "missing_request_subject",
        subject: request.id,
        detail: `Request ${request.id} references missing subject ${request.subjectId}.`,
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

  const latestState = new Map<string, LifecycleState>();
  const superseded = new Set(
    graph.events.flatMap((event) => (event.supersedes === undefined ? [] : [event.supersedes])),
  );

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

    const current = latestState.get(event.subjectId) ?? null;
    if (event.priorState !== current && event.transitionKind !== "correct") {
      issues.push({
        code: "prior_state_mismatch",
        subject: event.id,
        detail: `Expected prior state ${String(current)}, received ${String(event.priorState)}.`,
      });
    }

    if (event.supersedes !== undefined) {
      const prior = events.get(event.supersedes);
      if (prior === undefined || prior.subjectId !== event.subjectId) {
        issues.push({
          code: "invalid_supersession",
          subject: event.id,
          detail: "A correction must supersede an existing event for the same subject.",
        });
      }
      if (!event.basis.some((reference) => reference.kind === "graph_event")) {
        issues.push({
          code: "supersession_without_event_basis",
          subject: event.id,
          detail: "A correction must cite the superseded graph event.",
        });
      }
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
          detail: "A fulfilling event must match an existing request's subject and state.",
        });
      }
      if (!event.basis.some((reference) => reference.kind === "git_commit")) {
        issues.push({
          code: "request_fulfillment_without_commit",
          subject: event.id,
          detail:
            "Fulfilling a commit-declared request requires observing the immutable resulting commit.",
        });
      }
    }

    issues.push(...validateTransitionPolicy(event, node));
    latestState.set(event.subjectId, event.requestedState);
  }

  for (const eventId of superseded) {
    if (!events.has(eventId)) {
      issues.push({
        code: "missing_superseded_event",
        subject: eventId,
        detail: `Superseded event ${eventId} does not exist.`,
      });
    }
  }

  return { accepted: issues.length === 0, issues };
};

/**
 * Replays the event history with corrections applied at the position of the
 * event they supersede. A correction replaces the corrected event where it
 * happened; it does not append a new "latest" fact. Otherwise correcting a
 * non-latest event would overwrite later, uncorrected state.
 */
export const effectiveEvents = (graph: WorkGraph): ReadonlyArray<TransitionEvent> => {
  const replacedBy = new Map<string, TransitionEvent>();
  for (const event of graph.events) {
    if (event.supersedes !== undefined) replacedBy.set(event.supersedes, event);
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
  return graph.events.filter((event) => event.supersedes === undefined).map(resolve);
};

export const reduceLifecycle = (
  graph: WorkGraph,
): ReadonlyMap<string, LifecycleState | "locked"> => {
  const state = new Map<string, LifecycleState | "locked">(
    graph.nodes.map((node) => [node.id, "locked"]),
  );
  for (const event of effectiveEvents(graph)) state.set(event.subjectId, event.requestedState);
  return state;
};
