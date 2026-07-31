import { validateGraph, type ValidationIssue } from "./graph.ts";
import type { TransitionEvent, WorkGraph } from "./model.ts";
import { normalizeGraph, stableStringify } from "./normalize.ts";
import type { ResolvedPolicyRegistry } from "./policy-registry.ts";

export type Sha256Digest = `sha256:${string}`;
export type HashFunction = (text: string) => Sha256Digest;

export interface AppendReceipt {
  readonly idempotencyKey: string;
  readonly commandDigest: Sha256Digest;
  readonly policyRegistryDigest: Sha256Digest;
  readonly eventId: string;
  readonly eventIndex: number;
  readonly eventDigest: Sha256Digest;
  readonly priorEventChainDigest: Sha256Digest;
  readonly resultEventChainDigest: Sha256Digest;
  readonly priorRevision: number;
  readonly priorGraphDigest: Sha256Digest;
  readonly resultRevision: number;
  readonly resultGraphDigest: Sha256Digest;
}

export interface LocalWorkGraphDocument {
  readonly schemaVersion: "workgraph.local/v1alpha1";
  readonly revision: number;
  readonly graphDigest: Sha256Digest;
  readonly eventChainDigest: Sha256Digest;
  readonly genesis: {
    readonly staticGraphDigest: Sha256Digest;
    readonly graphDigest: Sha256Digest;
    readonly eventChainDigest: Sha256Digest;
    readonly eventCount: number;
  };
  readonly graph: WorkGraph;
  readonly receipts: ReadonlyArray<AppendReceipt>;
}

export interface AppendTransitionCommand {
  readonly schemaVersion: "workgraph.command.append-transition/v1alpha1";
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly expectedGraphDigest: Sha256Digest;
  readonly expectedPolicyRegistryDigest: Sha256Digest;
  readonly event: TransitionEvent;
}

export interface GraphIdentity {
  readonly revision: number;
  readonly graphDigest: Sha256Digest;
  readonly eventChainDigest: Sha256Digest;
  readonly documentDigest: Sha256Digest;
}

export type AppendDecision =
  | {
      readonly _tag: "Apply";
      readonly candidateGraph: WorkGraph;
      readonly nextRevision: number;
      readonly receiptSeed: Omit<
        AppendReceipt,
        "eventDigest" | "resultEventChainDigest" | "resultGraphDigest"
      >;
    }
  | { readonly _tag: "AlreadyApplied"; readonly receipt: AppendReceipt }
  | { readonly _tag: "Conflict"; readonly code: string; readonly detail: string }
  | { readonly _tag: "Rejected"; readonly issues: ReadonlyArray<ValidationIssue> };

export interface CoherenceResult {
  readonly accepted: boolean;
  readonly issues: ReadonlyArray<ValidationIssue>;
  readonly identity?: GraphIdentity;
}

const digestValue = (hash: HashFunction, value: unknown): Sha256Digest =>
  hash(stableStringify(value));

export const staticGraphDigest = (graph: WorkGraph, hash: HashFunction): Sha256Digest => {
  const normalized = normalizeGraph(graph);
  return digestValue(hash, {
    schemaVersion: "workgraph.local-static-graph/v1alpha1",
    graphSchemaVersion: graph.schemaVersion,
    nodes: normalized.nodes,
    edges: normalized.edges,
    requests: normalized.requests,
  });
};

export const emptyEventChainDigest = (
  staticDigest: Sha256Digest,
  hash: HashFunction,
): Sha256Digest =>
  digestValue(hash, {
    schemaVersion: "workgraph.event-chain-empty/v1alpha1",
    staticGraphDigest: staticDigest,
  });

export const eventDigest = (event: TransitionEvent, hash: HashFunction): Sha256Digest =>
  hash(stableStringify(event));

export const nextEventChainDigest = (
  priorEventChainDigest: Sha256Digest,
  eventIndex: number,
  digest: Sha256Digest,
  hash: HashFunction,
): Sha256Digest =>
  digestValue(hash, {
    schemaVersion: "workgraph.event-chain-step/v1alpha1",
    priorEventChainDigest,
    eventIndex,
    eventDigest: digest,
  });

export const localGraphDigest = (
  staticDigest: Sha256Digest,
  eventChainDigest: Sha256Digest,
  eventCount: number,
  hash: HashFunction,
): Sha256Digest =>
  digestValue(hash, {
    schemaVersion: "workgraph.local-graph-identity/v1alpha1",
    staticGraphDigest: staticDigest,
    eventChainDigest,
    eventCount,
  });

export const normalizeLocalDocument = (value: LocalWorkGraphDocument) => ({
  schemaVersion: value.schemaVersion,
  revision: value.revision,
  graphDigest: value.graphDigest,
  eventChainDigest: value.eventChainDigest,
  genesis: {
    staticGraphDigest: value.genesis.staticGraphDigest,
    graphDigest: value.genesis.graphDigest,
    eventChainDigest: value.genesis.eventChainDigest,
    eventCount: value.genesis.eventCount,
  },
  graph: normalizeGraph(value.graph),
  receipts: value.receipts.map((receipt) => ({
    idempotencyKey: receipt.idempotencyKey,
    commandDigest: receipt.commandDigest,
    policyRegistryDigest: receipt.policyRegistryDigest,
    eventId: receipt.eventId,
    eventIndex: receipt.eventIndex,
    eventDigest: receipt.eventDigest,
    priorEventChainDigest: receipt.priorEventChainDigest,
    resultEventChainDigest: receipt.resultEventChainDigest,
    priorRevision: receipt.priorRevision,
    priorGraphDigest: receipt.priorGraphDigest,
    resultRevision: receipt.resultRevision,
    resultGraphDigest: receipt.resultGraphDigest,
  })),
});

export const documentDigest = (
  document: LocalWorkGraphDocument,
  hash: HashFunction,
): Sha256Digest =>
  digestValue(hash, {
    schemaVersion: "workgraph.local-document-identity/v1alpha1",
    document: normalizeLocalDocument(document),
  });

export const createGenesisDocument = (
  graph: WorkGraph,
  hash: HashFunction,
): LocalWorkGraphDocument => {
  const normalized = normalizeGraph(graph);
  const staticDigest = staticGraphDigest(normalized, hash);
  let chainDigest = emptyEventChainDigest(staticDigest, hash);
  for (const [index, event] of normalized.events.entries()) {
    chainDigest = nextEventChainDigest(chainDigest, index, eventDigest(event, hash), hash);
  }
  const graphDigest = localGraphDigest(staticDigest, chainDigest, normalized.events.length, hash);
  return {
    schemaVersion: "workgraph.local/v1alpha1",
    revision: 0,
    graphDigest,
    eventChainDigest: chainDigest,
    genesis: {
      staticGraphDigest: staticDigest,
      graphDigest,
      eventChainDigest: chainDigest,
      eventCount: normalized.events.length,
    },
    graph: normalized,
    receipts: [],
  };
};

const coherenceIssue = (code: string, detail: string): ValidationIssue => ({
  code,
  subject: "$",
  detail,
});

export const validateDocumentCoherence = (
  document: LocalWorkGraphDocument,
  hash: HashFunction,
): CoherenceResult => {
  const issues: Array<ValidationIssue> = [];
  if (document.revision !== document.receipts.length) {
    issues.push(coherenceIssue("revision_receipt_mismatch", "Revision must equal receipt count."));
  }
  if (
    !Number.isSafeInteger(document.genesis.eventCount + document.revision) ||
    document.graph.events.length !== document.genesis.eventCount + document.revision
  ) {
    issues.push(
      coherenceIssue("event_count_mismatch", "Graph event count must equal genesis plus revision."),
    );
  }

  const keys = new Set<string>();
  const receiptEventIds = new Set<string>();
  const staticDigest = staticGraphDigest(document.graph, hash);
  if (staticDigest !== document.genesis.staticGraphDigest) {
    issues.push(coherenceIssue("static_graph_digest_mismatch", "Static graph digest differs."));
  }
  let chainDigest = emptyEventChainDigest(staticDigest, hash);
  let boundaryGraphDigest = localGraphDigest(staticDigest, chainDigest, 0, hash);
  if (
    document.genesis.eventCount === 0 &&
    (document.genesis.eventChainDigest !== chainDigest ||
      document.genesis.graphDigest !== boundaryGraphDigest)
  ) {
    issues.push(coherenceIssue("genesis_digest_mismatch", "Empty genesis boundary differs."));
  }

  for (const [index, event] of document.graph.events.entries()) {
    const digest = eventDigest(event, hash);
    chainDigest = nextEventChainDigest(chainDigest, index, digest, hash);
    if (index + 1 === document.genesis.eventCount) {
      boundaryGraphDigest = localGraphDigest(staticDigest, chainDigest, index + 1, hash);
      if (
        chainDigest !== document.genesis.eventChainDigest ||
        boundaryGraphDigest !== document.genesis.graphDigest
      ) {
        issues.push(coherenceIssue("genesis_digest_mismatch", "Genesis event boundary differs."));
      }
    }
    if (index < document.genesis.eventCount) continue;
    const receiptIndex = index - document.genesis.eventCount;
    const receipt = document.receipts[receiptIndex];
    if (receipt === undefined) continue;
    if (keys.has(receipt.idempotencyKey)) {
      issues.push(coherenceIssue("duplicate_receipt_key", receipt.idempotencyKey));
    }
    keys.add(receipt.idempotencyKey);
    if (receiptEventIds.has(receipt.eventId)) {
      issues.push(coherenceIssue("duplicate_receipt_event", receipt.eventId));
    }
    receiptEventIds.add(receipt.eventId);
    if (
      receipt.priorRevision !== receiptIndex ||
      receipt.resultRevision !== receiptIndex + 1 ||
      receipt.eventIndex !== index
    ) {
      issues.push(coherenceIssue("receipt_position_mismatch", receipt.eventId));
    }
    if (
      receipt.eventId !== event.id ||
      receipt.eventDigest !== digest ||
      receipt.priorEventChainDigest !==
        (receiptIndex === 0
          ? document.genesis.eventChainDigest
          : document.receipts[receiptIndex - 1]?.resultEventChainDigest) ||
      receipt.resultEventChainDigest !== chainDigest
    ) {
      issues.push(coherenceIssue("receipt_event_chain_mismatch", receipt.eventId));
    }
    if (receipt.priorGraphDigest !== boundaryGraphDigest) {
      issues.push(coherenceIssue("receipt_prior_graph_mismatch", receipt.eventId));
    }
    boundaryGraphDigest = localGraphDigest(staticDigest, chainDigest, index + 1, hash);
    if (receipt.resultGraphDigest !== boundaryGraphDigest) {
      issues.push(coherenceIssue("receipt_result_graph_mismatch", receipt.eventId));
    }
  }

  if (chainDigest !== document.eventChainDigest || boundaryGraphDigest !== document.graphDigest) {
    issues.push(coherenceIssue("envelope_digest_mismatch", "Envelope identity differs."));
  }

  if (issues.length > 0) return { accepted: false, issues };
  return {
    accepted: true,
    issues: [],
    identity: {
      revision: document.revision,
      graphDigest: document.graphDigest,
      eventChainDigest: document.eventChainDigest,
      documentDigest: documentDigest(document, hash),
    },
  };
};

export const commandDigest = (command: AppendTransitionCommand, hash: HashFunction): Sha256Digest =>
  hash(stableStringify(command));

const inputBoundIssues = (graph: WorkGraph): ReadonlyArray<ValidationIssue> => {
  const entries =
    graph.nodes.length + graph.edges.length + graph.events.length + graph.requests.length;
  return graph.events.length > 1_000 || entries > 100_000
    ? [
        {
          code: "input_bound_exceeded",
          subject: "$.graph",
          detail: "Candidate graph exceeds the public collection limit.",
        },
      ]
    : [];
};

export const decideAppend = (
  document: LocalWorkGraphDocument,
  identity: GraphIdentity,
  command: AppendTransitionCommand,
  digest: Sha256Digest,
  registry: ResolvedPolicyRegistry,
): AppendDecision => {
  const receipt = document.receipts.find(
    (candidate) => candidate.idempotencyKey === command.idempotencyKey,
  );
  if (receipt !== undefined) {
    return receipt.commandDigest === digest
      ? { _tag: "AlreadyApplied", receipt }
      : {
          _tag: "Conflict",
          code: "idempotency_key_reused",
          detail: "The idempotency key is bound to different command bytes.",
        };
  }
  if (command.expectedPolicyRegistryDigest !== registry.digest) {
    return {
      _tag: "Conflict",
      code: "policy_registry_changed",
      detail: "The resolved policy registry differs from the command.",
    };
  }
  if (command.expectedRevision !== identity.revision) {
    return {
      _tag: "Conflict",
      code: "store_revision_changed",
      detail: "The store revision differs from the command.",
    };
  }
  if (command.expectedGraphDigest !== identity.graphDigest) {
    return {
      _tag: "Conflict",
      code: "graph_digest_changed",
      detail: "The graph digest differs from the command.",
    };
  }
  if (document.graph.events.some((event) => event.id === command.event.id)) {
    return {
      _tag: "Conflict",
      code: "event_id_exists",
      detail: "The event identifier already exists.",
    };
  }
  const candidateGraph: WorkGraph = {
    ...document.graph,
    events: [...document.graph.events, command.event],
  };
  const boundIssues = inputBoundIssues(candidateGraph);
  if (boundIssues.length > 0) return { _tag: "Rejected", issues: boundIssues };
  const validation = validateGraph(candidateGraph, registry);
  if (!validation.accepted) return { _tag: "Rejected", issues: validation.issues };

  return {
    _tag: "Apply",
    candidateGraph,
    nextRevision: document.revision + 1,
    receiptSeed: {
      idempotencyKey: command.idempotencyKey,
      commandDigest: digest,
      policyRegistryDigest: registry.digest,
      eventId: command.event.id,
      eventIndex: document.graph.events.length,
      priorEventChainDigest: document.eventChainDigest,
      priorRevision: document.revision,
      priorGraphDigest: document.graphDigest,
      resultRevision: document.revision + 1,
    },
  };
};

export const completeAppend = (
  document: LocalWorkGraphDocument,
  decision: Extract<AppendDecision, { readonly _tag: "Apply" }>,
  hash: HashFunction,
): LocalWorkGraphDocument => {
  const appended = decision.candidateGraph.events.at(-1)!;
  const appendedDigest = eventDigest(appended, hash);
  const resultChainDigest = nextEventChainDigest(
    document.eventChainDigest,
    decision.receiptSeed.eventIndex,
    appendedDigest,
    hash,
  );
  const resultGraphDigest = localGraphDigest(
    document.genesis.staticGraphDigest,
    resultChainDigest,
    decision.candidateGraph.events.length,
    hash,
  );
  const receipt: AppendReceipt = {
    ...decision.receiptSeed,
    eventDigest: appendedDigest,
    resultEventChainDigest: resultChainDigest,
    resultGraphDigest,
  };
  return {
    ...document,
    revision: decision.nextRevision,
    graphDigest: resultGraphDigest,
    eventChainDigest: resultChainDigest,
    graph: decision.candidateGraph,
    receipts: [...document.receipts, receipt],
  };
};
