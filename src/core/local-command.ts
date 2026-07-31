import { validateGraph, type ValidationIssue } from "./graph.ts";
import type { TransitionEvent, WorkGraph } from "./model.ts";
import { immutableSnapshot, normalizeGraph, stableStringify } from "./normalize.ts";
import { authenticatePolicyRegistry, type ResolvedPolicyRegistry } from "./policy-registry.ts";

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

type ApplyDecision = Extract<AppendDecision, { readonly _tag: "Apply" }>;

export type AppendCompletion =
  | { readonly ok: true; readonly document: LocalWorkGraphDocument }
  | { readonly ok: false; readonly issues: ReadonlyArray<ValidationIssue> };

export interface DocumentCollectionCounts {
  readonly nodes: number;
  readonly edges: number;
  readonly events: number;
  readonly requests: number;
  readonly receipts: number;
}

export const withinPublicDocumentBounds = (counts: DocumentCollectionCounts): boolean =>
  counts.events <= 1_000 &&
  counts.nodes + counts.edges + counts.events + counts.requests + counts.receipts <= 100_000;

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
  return immutableSnapshot({
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
  });
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

interface IssuedApplyBinding {
  readonly documentDigest: Sha256Digest;
  readonly policyRegistryDigest: Sha256Digest;
}

const issuedApplyDecisions = new WeakMap<ApplyDecision, IssuedApplyBinding>();

const inputBoundIssues = (
  graph: WorkGraph,
  receiptCount: number,
): ReadonlyArray<ValidationIssue> => {
  return !withinPublicDocumentBounds({
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    events: graph.events.length,
    requests: graph.requests.length,
    receipts: receiptCount,
  })
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
  hash: HashFunction,
): AppendDecision => {
  const commandSnapshot = immutableSnapshot(command);
  const coherence = validateDocumentCoherence(document, hash);
  if (!coherence.accepted || coherence.identity === undefined) {
    return { _tag: "Rejected", issues: coherence.issues };
  }
  if (
    identity.revision !== coherence.identity.revision ||
    identity.graphDigest !== coherence.identity.graphDigest ||
    identity.eventChainDigest !== coherence.identity.eventChainDigest ||
    identity.documentDigest !== coherence.identity.documentDigest
  ) {
    return {
      _tag: "Rejected",
      issues: [
        coherenceIssue(
          "identity_authentication_failed",
          "Supplied identity does not match the coherent document.",
        ),
      ],
    };
  }
  if (digest !== commandDigest(commandSnapshot, hash)) {
    return {
      _tag: "Rejected",
      issues: [
        coherenceIssue(
          "command_digest_authentication_failed",
          "Supplied command digest does not match the command.",
        ),
      ],
    };
  }
  const receipt = document.receipts.find(
    (candidate) => candidate.idempotencyKey === commandSnapshot.idempotencyKey,
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
  if (commandSnapshot.expectedPolicyRegistryDigest !== registry.digest) {
    return {
      _tag: "Conflict",
      code: "policy_registry_changed",
      detail: "The resolved policy registry differs from the command.",
    };
  }
  if (!authenticatePolicyRegistry(registry, hash)) {
    return {
      _tag: "Conflict",
      code: "policy_registry_invalid",
      detail: "The resolved policy registry does not authenticate.",
    };
  }
  if (commandSnapshot.expectedRevision !== identity.revision) {
    return {
      _tag: "Conflict",
      code: "store_revision_changed",
      detail: "The store revision differs from the command.",
    };
  }
  if (commandSnapshot.expectedGraphDigest !== identity.graphDigest) {
    return {
      _tag: "Conflict",
      code: "graph_digest_changed",
      detail: "The graph digest differs from the command.",
    };
  }
  if (document.graph.events.some((event) => event.id === commandSnapshot.event.id)) {
    return {
      _tag: "Conflict",
      code: "event_id_exists",
      detail: "The event identifier already exists.",
    };
  }
  const candidateGraph = normalizeGraph({
    ...document.graph,
    events: [...document.graph.events, commandSnapshot.event],
  });
  const boundIssues = inputBoundIssues(candidateGraph, document.receipts.length + 1);
  if (boundIssues.length > 0) return { _tag: "Rejected", issues: boundIssues };
  const validation = validateGraph(candidateGraph, registry);
  if (!validation.accepted) return { _tag: "Rejected", issues: validation.issues };

  const decision = immutableSnapshot<ApplyDecision>({
    _tag: "Apply",
    candidateGraph,
    nextRevision: document.revision + 1,
    receiptSeed: {
      idempotencyKey: commandSnapshot.idempotencyKey,
      commandDigest: digest,
      policyRegistryDigest: registry.digest,
      eventId: commandSnapshot.event.id,
      eventIndex: document.graph.events.length,
      priorEventChainDigest: document.eventChainDigest,
      priorRevision: document.revision,
      priorGraphDigest: document.graphDigest,
      resultRevision: document.revision + 1,
    },
  });
  issuedApplyDecisions.set(
    decision,
    immutableSnapshot({
      documentDigest: coherence.identity.documentDigest,
      policyRegistryDigest: registry.digest,
    }),
  );
  return decision;
};

export const completeAppend = (
  document: LocalWorkGraphDocument,
  decision: ApplyDecision,
  hash: HashFunction,
  registry: ResolvedPolicyRegistry,
): AppendCompletion => {
  const issuedBinding = issuedApplyDecisions.get(decision);
  if (issuedBinding === undefined) {
    return {
      ok: false,
      issues: [
        coherenceIssue(
          "append_plan_authentication_failed",
          "Append plan was not issued by this decision authority.",
        ),
      ],
    };
  }
  const coherence = validateDocumentCoherence(document, hash);
  if (
    !coherence.accepted ||
    coherence.identity === undefined ||
    coherence.identity.documentDigest !== issuedBinding.documentDigest ||
    registry.digest !== issuedBinding.policyRegistryDigest ||
    !authenticatePolicyRegistry(registry, hash)
  ) {
    return {
      ok: false,
      issues: [
        ...coherence.issues,
        coherenceIssue(
          "append_plan_authentication_failed",
          "Append plan is not bound to this document and policy registry.",
        ),
      ],
    };
  }
  const prefix = decision.candidateGraph.events.slice(0, document.graph.events.length);
  const completionIssues: Array<ValidationIssue> = [
    ...coherence.issues,
    ...inputBoundIssues(decision.candidateGraph, document.receipts.length + 1),
  ];
  if (
    !authenticatePolicyRegistry(registry, hash) ||
    decision.nextRevision !== document.revision + 1 ||
    decision.receiptSeed.priorRevision !== document.revision ||
    decision.receiptSeed.resultRevision !== decision.nextRevision ||
    decision.receiptSeed.eventIndex !== document.graph.events.length ||
    decision.receiptSeed.priorGraphDigest !== document.graphDigest ||
    decision.receiptSeed.priorEventChainDigest !== document.eventChainDigest ||
    decision.receiptSeed.policyRegistryDigest !== registry.digest ||
    decision.candidateGraph.events.length !== document.graph.events.length + 1 ||
    stableStringify(prefix) !== stableStringify(document.graph.events)
  ) {
    completionIssues.push(
      coherenceIssue(
        "append_plan_authentication_failed",
        "Append plan is not bound to the document.",
      ),
    );
  }
  const candidateValidation = validateGraph(decision.candidateGraph, registry);
  completionIssues.push(...candidateValidation.issues);
  if (completionIssues.length > 0) return { ok: false, issues: completionIssues };

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
  const completed = immutableSnapshot<LocalWorkGraphDocument>({
    ...document,
    revision: decision.nextRevision,
    graphDigest: resultGraphDigest,
    eventChainDigest: resultChainDigest,
    graph: decision.candidateGraph,
    receipts: [...document.receipts, receipt],
  });
  const completedCoherence = validateDocumentCoherence(completed, hash);
  return completedCoherence.accepted
    ? { ok: true, document: completed }
    : { ok: false, issues: completedCoherence.issues };
};
