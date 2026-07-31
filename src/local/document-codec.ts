import { createHash } from "node:crypto";
import type {
  AppendTransitionCommand,
  LocalWorkGraphDocument,
  Sha256Digest,
} from "../core/local-command.ts";
import type {
  ArtifactReference,
  BasisReference,
  ExactSubjectReference,
  HumanApprovalReference,
  MachineCheckReference,
  TransitionEvent,
  WorkGraph,
} from "../core/model.ts";
import {
  EDGE_KINDS,
  LIFECYCLE_STATES,
  NODE_KINDS,
  type WorkEdge,
  type WorkNode,
} from "../core/model.ts";
import { stableStringify } from "../core/normalize.ts";
import type {
  PolicyDefinitionsDocument,
  TransitionPolicyDefinition,
} from "../core/policy-registry.ts";

export interface DecodeIssue {
  readonly path: string;
  readonly code: string;
  readonly detail: string;
}

export type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: ReadonlyArray<DecodeIssue> };

const issue = (path: string, code: string, detail: string): DecodeIssue => ({
  path,
  code,
  detail,
});

class StrictJsonParser {
  readonly #source: string;
  #index = 0;
  #values = 0;

  constructor(source: string) {
    this.#source = source;
  }

  parse(): unknown {
    const value = this.#value(0, "$");
    this.#space();
    if (this.#index !== this.#source.length) {
      throw issue("$", "trailing_json", "Unexpected bytes after the JSON value.");
    }
    return value;
  }

  #space(): void {
    while (/\s/u.test(this.#source[this.#index] ?? "")) this.#index += 1;
  }

  #value(depth: number, path: string): unknown {
    if (depth > 64) throw issue(path, "depth_exceeded", "JSON nesting exceeds 64 levels.");
    this.#values += 1;
    if (this.#values > 300_000) {
      throw issue(path, "value_count_exceeded", "JSON contains too many values.");
    }
    this.#space();
    const char = this.#source[this.#index];
    if (char === "{") return this.#object(depth + 1, path);
    if (char === "[") return this.#array(depth + 1, path);
    if (char === '"') return this.#string(path);
    if (this.#source.startsWith("true", this.#index)) {
      this.#index += 4;
      return true;
    }
    if (this.#source.startsWith("false", this.#index)) {
      this.#index += 5;
      return false;
    }
    if (this.#source.startsWith("null", this.#index)) {
      this.#index += 4;
      return null;
    }
    const match = this.#source
      .slice(this.#index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (match !== null) {
      this.#index += match[0].length;
      const value = Number(match[0]);
      if (!Number.isFinite(value)) throw issue(path, "invalid_number", "Number is not finite.");
      return value;
    }
    throw issue(path, "invalid_json", `Unexpected token at byte ${this.#index}.`);
  }

  #string(path: string): string {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#source.length) {
      const char = this.#source[this.#index]!;
      if (char === "\\") {
        this.#index += 2;
        continue;
      }
      if (char === '"') {
        this.#index += 1;
        try {
          return JSON.parse(this.#source.slice(start, this.#index)) as string;
        } catch {
          throw issue(path, "invalid_string", "Invalid JSON string.");
        }
      }
      if (char.charCodeAt(0) < 0x20) {
        throw issue(path, "invalid_string", "Unescaped control byte in string.");
      }
      this.#index += 1;
    }
    throw issue(path, "invalid_string", "Unterminated JSON string.");
  }

  #object(depth: number, path: string): Readonly<Record<string, unknown>> {
    this.#index += 1;
    const value: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.#space();
    if (this.#source[this.#index] === "}") {
      this.#index += 1;
      return value;
    }
    while (true) {
      this.#space();
      if (this.#source[this.#index] !== '"') {
        throw issue(path, "invalid_object", "Object key must be a JSON string.");
      }
      const key = this.#string(path);
      if (keys.has(key)) throw issue(`${path}.${key}`, "duplicate_key", `Duplicate key ${key}.`);
      keys.add(key);
      this.#space();
      if (this.#source[this.#index] !== ":") {
        throw issue(`${path}.${key}`, "invalid_object", "Missing colon after object key.");
      }
      this.#index += 1;
      value[key] = this.#value(depth, `${path}.${key}`);
      this.#space();
      const char = this.#source[this.#index];
      if (char === "}") {
        this.#index += 1;
        return value;
      }
      if (char !== ",") throw issue(path, "invalid_object", "Expected comma or object end.");
      this.#index += 1;
    }
  }

  #array(depth: number, path: string): ReadonlyArray<unknown> {
    this.#index += 1;
    const value: Array<unknown> = [];
    this.#space();
    if (this.#source[this.#index] === "]") {
      this.#index += 1;
      return value;
    }
    while (true) {
      value.push(this.#value(depth, `${path}[${value.length}]`));
      this.#space();
      const char = this.#source[this.#index];
      if (char === "]") {
        this.#index += 1;
        return value;
      }
      if (char !== ",") throw issue(path, "invalid_array", "Expected comma or array end.");
      this.#index += 1;
    }
  }
}

const parseJson = (source: string): DecodeResult<unknown> => {
  if (new TextEncoder().encode(source).length > 8 * 1024 * 1024) {
    return {
      ok: false,
      issues: [issue("$", "source_too_large", "Source exceeds 8 MiB.")],
    };
  }
  try {
    return { ok: true, value: new StrictJsonParser(source).parse() };
  } catch (error) {
    return {
      ok: false,
      issues: [
        typeof error === "object" && error !== null && "code" in error
          ? (error as DecodeIssue)
          : issue("$", "invalid_json", String(error)),
      ],
    };
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isDigest = (value: unknown): value is Sha256Digest =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
const isEnum = <T extends string>(value: unknown, values: ReadonlyArray<T>): value is T =>
  typeof value === "string" && (values as ReadonlyArray<string>).includes(value);

const exactKeys = (
  value: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  );
};

const isAttributes = (
  value: unknown,
): value is Readonly<Record<string, string | number | boolean>> =>
  isRecord(value) &&
  Object.values(value).every(
    (entry) =>
      typeof entry === "string" || typeof entry === "boolean" || Number.isSafeInteger(entry),
  );

const isArtifact = (value: unknown): value is ArtifactReference =>
  isRecord(value) &&
  exactKeys(value, ["kind", "algorithm", "digest", "mediaType"], ["producedBy", "locator"]) &&
  value.kind === "artifact" &&
  (value.algorithm === "sha256" || value.algorithm === "sha512") &&
  isString(value.digest) &&
  isString(value.mediaType) &&
  (value.producedBy === undefined || isString(value.producedBy)) &&
  (value.locator === undefined || isString(value.locator));

const isExactSubject = (value: unknown): value is ExactSubjectReference => {
  if (isArtifact(value)) return true;
  return (
    isRecord(value) &&
    exactKeys(
      value,
      ["kind", "repository", "objectFormat", "objectId", "observedBy"],
      ["path", "mutableContext"],
    ) &&
    value.kind === "git_commit" &&
    isString(value.repository) &&
    (value.objectFormat === "sha1" || value.objectFormat === "sha256") &&
    isString(value.objectId) &&
    isString(value.observedBy) &&
    (value.path === undefined || isString(value.path)) &&
    (value.mutableContext === undefined || isString(value.mutableContext))
  );
};

const isHumanApproval = (value: unknown): value is HumanApprovalReference =>
  isRecord(value) &&
  exactKeys(value, [
    "kind",
    "actor",
    "authentication",
    "authorityScope",
    "subjects",
    "approvedTransition",
    "rationale",
    "approvedAt",
    "evidenceCategory",
    "machineChecked",
  ]) &&
  value.kind === "human_approval" &&
  isString(value.actor) &&
  isEnum(value.authentication, ["unverified", "provider_authenticated", "signed"]) &&
  isString(value.authorityScope) &&
  Array.isArray(value.subjects) &&
  value.subjects.every(isExactSubject) &&
  isEnum(value.approvedTransition, LIFECYCLE_STATES) &&
  isString(value.rationale) &&
  isString(value.approvedAt) &&
  value.evidenceCategory === "human_approved_assertion" &&
  value.machineChecked === false;

const isMachineCheck = (value: unknown): value is MachineCheckReference =>
  isRecord(value) &&
  exactKeys(value, [
    "kind",
    "checker",
    "checkerVersion",
    "subjects",
    "policy",
    "operation",
    "environment",
    "result",
    "exitCode",
    "output",
    "observedAt",
  ]) &&
  value.kind === "machine_check" &&
  isString(value.checker) &&
  isString(value.checkerVersion) &&
  Array.isArray(value.subjects) &&
  value.subjects.every(isExactSubject) &&
  isString(value.policy) &&
  isString(value.operation) &&
  isString(value.environment) &&
  isEnum(value.result, ["passed", "failed", "indeterminate"]) &&
  typeof value.exitCode === "number" &&
  Number.isSafeInteger(value.exitCode) &&
  isArtifact(value.output) &&
  isString(value.observedAt);

const isBasis = (value: unknown): value is BasisReference => {
  if (isExactSubject(value) || isMachineCheck(value) || isHumanApproval(value)) return true;
  if (!isRecord(value) || !isString(value.kind)) return false;
  if (value.kind === "graph_event") {
    return exactKeys(value, ["kind", "eventId"]) && isString(value.eventId);
  }
  if (value.kind === "external_record") {
    return (
      exactKeys(
        value,
        ["kind", "provider", "project", "recordId", "observedAt", "interpretation"],
        ["observedVersion"],
      ) &&
      isString(value.provider) &&
      isString(value.project) &&
      isString(value.recordId) &&
      isString(value.observedAt) &&
      isString(value.interpretation) &&
      (value.observedVersion === undefined || isString(value.observedVersion))
    );
  }
  return false;
};

const isTransition = (value: unknown): value is TransitionEvent =>
  isRecord(value) &&
  exactKeys(
    value,
    [
      "id",
      "subjectId",
      "priorState",
      "requestedState",
      "transitionKind",
      "actor",
      "authority",
      "evidenceCategory",
      "basis",
      "policy",
      "policyVersion",
      "rationale",
      "observedAt",
    ],
    ["supersedes", "fulfillsRequest"],
  ) &&
  isString(value.id) &&
  isString(value.subjectId) &&
  (value.priorState === null || isEnum(value.priorState, LIFECYCLE_STATES)) &&
  isEnum(value.requestedState, LIFECYCLE_STATES) &&
  isEnum(value.transitionKind, ["advance", "reopen", "correct"]) &&
  isString(value.actor) &&
  isEnum(value.authority, [
    "machine_policy",
    "human_approval",
    "imported_observation",
    "administrative_assertion",
  ]) &&
  isEnum(value.evidenceCategory, [
    "machine_check",
    "human_approved_assertion",
    "external_observation",
    "agent_assertion",
    "assumption",
  ]) &&
  Array.isArray(value.basis) &&
  value.basis.length > 0 &&
  value.basis.every(isBasis) &&
  isString(value.policy) &&
  isString(value.policyVersion) &&
  isString(value.rationale) &&
  isString(value.observedAt) &&
  (value.supersedes === undefined || isString(value.supersedes)) &&
  (value.fulfillsRequest === undefined || isString(value.fulfillsRequest));

const isNode = (value: unknown): value is WorkNode =>
  isRecord(value) &&
  exactKeys(value, ["id", "kind", "title"], ["exactSubject", "evidenceRole", "attributes"]) &&
  isString(value.id) &&
  isEnum(value.kind, NODE_KINDS) &&
  isString(value.title) &&
  (value.exactSubject === undefined || isExactSubject(value.exactSubject)) &&
  (value.evidenceRole === undefined ||
    isEnum(value.evidenceRole, [
      "independent_review",
      "integration_observation",
      "operational_observation",
    ])) &&
  (value.attributes === undefined || isAttributes(value.attributes));

const isEdge = (value: unknown): value is WorkEdge =>
  isRecord(value) &&
  exactKeys(value, ["id", "kind", "from", "to"], ["attributes"]) &&
  isString(value.id) &&
  isEnum(value.kind, EDGE_KINDS) &&
  isString(value.from) &&
  isString(value.to) &&
  (value.attributes === undefined || isAttributes(value.attributes));

const isGraph = (value: unknown): value is WorkGraph =>
  isRecord(value) &&
  exactKeys(value, ["schemaVersion", "nodes", "edges", "events", "requests"]) &&
  value.schemaVersion === "workgraph/v1alpha1" &&
  Array.isArray(value.nodes) &&
  value.nodes.every(isNode) &&
  Array.isArray(value.edges) &&
  value.edges.every(isEdge) &&
  Array.isArray(value.events) &&
  value.events.every(isTransition) &&
  Array.isArray(value.requests) &&
  value.requests.every(
    (request) =>
      isRecord(request) &&
      exactKeys(request, [
        "id",
        "subjectId",
        "requestedState",
        "declaredBy",
        "declaredInRepository",
        "rationale",
      ]) &&
      isString(request.id) &&
      isString(request.subjectId) &&
      isEnum(request.requestedState, LIFECYCLE_STATES) &&
      isString(request.declaredBy) &&
      isString(request.declaredInRepository) &&
      isString(request.rationale),
  );

const isReceipt = (value: unknown): boolean =>
  isRecord(value) &&
  exactKeys(value, [
    "idempotencyKey",
    "commandDigest",
    "policyRegistryDigest",
    "eventId",
    "eventIndex",
    "eventDigest",
    "priorEventChainDigest",
    "resultEventChainDigest",
    "priorRevision",
    "priorGraphDigest",
    "resultRevision",
    "resultGraphDigest",
  ]) &&
  isString(value.idempotencyKey) &&
  new TextEncoder().encode(value.idempotencyKey).length <= 256 &&
  isDigest(value.commandDigest) &&
  isDigest(value.policyRegistryDigest) &&
  isString(value.eventId) &&
  isSafeInteger(value.eventIndex) &&
  isDigest(value.eventDigest) &&
  isDigest(value.priorEventChainDigest) &&
  isDigest(value.resultEventChainDigest) &&
  isSafeInteger(value.priorRevision) &&
  isDigest(value.priorGraphDigest) &&
  isSafeInteger(value.resultRevision) &&
  isDigest(value.resultGraphDigest);

const decodeAs = <T>(
  source: string,
  guard: (value: unknown) => value is T,
  code: string,
): DecodeResult<T> => {
  const parsed = parseJson(source);
  if (!parsed.ok) return parsed;
  return guard(parsed.value)
    ? { ok: true, value: parsed.value }
    : {
        ok: false,
        issues: [issue("$", code, "Value does not match the exact schema.")],
      };
};

export const decodeWorkGraph = (source: string): DecodeResult<WorkGraph> => {
  const result = decodeAs(source, isGraph, "invalid_work_graph");
  if (
    result.ok &&
    (result.value.events.length > 1_000 ||
      result.value.nodes.length +
        result.value.edges.length +
        result.value.events.length +
        result.value.requests.length >
        100_000)
  ) {
    return {
      ok: false,
      issues: [issue("$.events", "input_bound_exceeded", "Graph exceeds collection bounds.")],
    };
  }
  return result;
};

export const decodeLocalDocument = (source: string): DecodeResult<LocalWorkGraphDocument> => {
  const result = decodeAs(
    source,
    (value): value is LocalWorkGraphDocument =>
      isRecord(value) &&
      exactKeys(value, [
        "schemaVersion",
        "revision",
        "graphDigest",
        "eventChainDigest",
        "genesis",
        "graph",
        "receipts",
      ]) &&
      value.schemaVersion === "workgraph.local/v1alpha1" &&
      isSafeInteger(value.revision) &&
      isDigest(value.graphDigest) &&
      isDigest(value.eventChainDigest) &&
      isRecord(value.genesis) &&
      exactKeys(value.genesis, [
        "staticGraphDigest",
        "graphDigest",
        "eventChainDigest",
        "eventCount",
      ]) &&
      isDigest(value.genesis.staticGraphDigest) &&
      isDigest(value.genesis.graphDigest) &&
      isDigest(value.genesis.eventChainDigest) &&
      isSafeInteger(value.genesis.eventCount) &&
      isGraph(value.graph) &&
      Array.isArray(value.receipts) &&
      value.receipts.every(isReceipt),
    "invalid_local_document",
  );
  if (
    result.ok &&
    (result.value.graph.events.length > 1_000 ||
      result.value.graph.nodes.length +
        result.value.graph.edges.length +
        result.value.graph.events.length +
        result.value.graph.requests.length +
        result.value.receipts.length >
        100_000)
  ) {
    return {
      ok: false,
      issues: [issue("$", "input_bound_exceeded", "Document exceeds collection bounds.")],
    };
  }
  return result;
};

export const decodeAppendCommand = (source: string): DecodeResult<AppendTransitionCommand> =>
  decodeAs(
    source,
    (value): value is AppendTransitionCommand =>
      isRecord(value) &&
      exactKeys(value, [
        "schemaVersion",
        "idempotencyKey",
        "expectedRevision",
        "expectedGraphDigest",
        "expectedPolicyRegistryDigest",
        "event",
      ]) &&
      value.schemaVersion === "workgraph.command.append-transition/v1alpha1" &&
      isString(value.idempotencyKey) &&
      value.idempotencyKey.length > 0 &&
      new TextEncoder().encode(value.idempotencyKey).length <= 256 &&
      isSafeInteger(value.expectedRevision) &&
      isDigest(value.expectedGraphDigest) &&
      isDigest(value.expectedPolicyRegistryDigest) &&
      isTransition(value.event),
    "invalid_append_command",
  );

const isPolicyDefinition = (value: unknown): value is TransitionPolicyDefinition =>
  isRecord(value) &&
  exactKeys(
    value,
    ["id", "version", "authority", "evidenceCategory", "rules"],
    ["acceptanceContract"],
  ) &&
  isString(value.id) &&
  isString(value.version) &&
  isEnum(value.authority, [
    "machine_policy",
    "human_approval",
    "imported_observation",
    "administrative_assertion",
  ]) &&
  isEnum(value.evidenceCategory, [
    "machine_check",
    "human_approved_assertion",
    "external_observation",
    "agent_assertion",
    "assumption",
  ]) &&
  Array.isArray(value.rules) &&
  value.rules.every(
    (rule) =>
      isRecord(rule) &&
      exactKeys(rule, ["priorState", "requestedState", "transitionKind"]) &&
      (rule.priorState === null || isEnum(rule.priorState, LIFECYCLE_STATES)) &&
      isEnum(rule.requestedState, LIFECYCLE_STATES) &&
      isEnum(rule.transitionKind, ["advance", "reopen", "correct"]),
  ) &&
  (value.acceptanceContract === undefined || isString(value.acceptanceContract));

export const decodePolicyDefinitions = (source: string): DecodeResult<PolicyDefinitionsDocument> =>
  decodeAs(
    source,
    (value): value is PolicyDefinitionsDocument =>
      isRecord(value) &&
      exactKeys(value, ["schemaVersion", "definitions"]) &&
      value.schemaVersion === "workgraph.policy-definitions/v1alpha1" &&
      Array.isArray(value.definitions) &&
      value.definitions.every(isPolicyDefinition),
    "invalid_policy_definitions",
  );

export const encodeLocalDocument = (document: LocalWorkGraphDocument): string =>
  stableStringify(document);
export const encodeJsonResult = (value: unknown): string => stableStringify(value);
export const sha256Text = (text: string): Sha256Digest =>
  `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
