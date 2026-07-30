import type { WorkGraph } from "./model.ts";

/**
 * Byte-determinism note: ordering uses UTF-16 code-unit comparison only.
 * Locale-aware comparison would make normalization environment-dependent and
 * break Bun/Node byte equivalence.
 */
const byCodeUnit = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const normalizeGraph = (graph: WorkGraph): WorkGraph => ({
  schemaVersion: graph.schemaVersion,
  nodes: graph.nodes.toSorted((a, b) => byCodeUnit(a.id, b.id)),
  edges: graph.edges.toSorted((a, b) => byCodeUnit(a.id, b.id)),
  // Event array order is canonical append order. `observedAt` records when
  // evidence was observed; sorting by it would let a late or corrected clock
  // rewrite lifecycle causality.
  events: [...graph.events],
  requests: graph.requests.toSorted((a, b) => byCodeUnit(a.id, b.id)),
});

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted(byCodeUnit)
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, stableValue(record[key])]),
    );
  }
  return value;
};

/** Deterministic JSON: sorted object keys, two-space indent, trailing newline. */
export const stableStringify = (value: unknown): string =>
  `${JSON.stringify(stableValue(value), null, 2)}\n`;
