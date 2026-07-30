# Tracer 0001 provenance and evidence limits

This report records what was evaluated, what the implementation reuses, and
what it does not claim. It describes the first Workgraph tracer only. It does
not select a license for Workgraph; the repository remains without an
operator-selected project license.

## Reused repository patterns

The correction pass first reused the existing tracer's typed model,
deterministic `stableStringify`, Effect service/layer composition, Bun/Node
journey, portable-core import allowlist, forbidden-claim vocabulary, and
adversarial fixture style. The implementation extends those established
patterns instead of adding a second model, serializer, runtime abstraction, or
test harness.

The transition policy is a small source-visible table. The reducer remains a
direct append-order replay with correction substitution at the original event
position. This was preferred over introducing a rules framework or event-store
dependency because the frozen tracer has four authorities, five evidence
categories, and a bounded policy set.

## Upstream software used

Versions are pinned by `package.json` and `bun.lock`; license values below were
checked in the installed package metadata.

| Upstream                                       | Use in this tracer                                                          | Upstream license                                                | Reuse boundary                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| Effect 4 beta 102 and Effect platform adapters | Typed composition roots, services, failures, and Bun/Node filesystem layers | MIT                                                             | Package dependency; no source copied into Workgraph            |
| Bun 1.3.13                                     | Default runtime, package manager, tests, and subprocess orchestration       | MIT project distribution with its own bundled-component notices | Runtime/tool invocation; no Bun source copied                  |
| Node.js 24                                     | Independent runtime composition and parity journey                          | MIT                                                             | Runtime/tool invocation; no Node source copied                 |
| Oxlint 1.76                                    | AST/scope-aware linting, including forbidden ambient globals in `src/core`  | MIT                                                             | Development tool and configuration only                        |
| Oxfmt 0.61                                     | Deterministic source formatting gate                                        | MIT                                                             | Development tool only                                          |
| TypeScript 7.0.2 / Effect TSGO 0.24.3          | Static types and Effect diagnostics                                         | Apache-2.0 / MIT                                                | Development tools only                                         |
| Mermaid syntax                                 | Textual roadmap projection format                                           | Mermaid project is MIT                                          | Only emitted syntax is used; Mermaid is not linked or vendored |

Transitive dependency licenses remain governed by their own package notices.
This report is provenance inventory, not legal advice and not a Workgraph
license grant.

## Prior art evaluated but not copied

| Prior art                                                                                         | Technique evaluated                                                                           | Decision                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git immutable object names and append-oriented history (Git project, GPL-2.0)                     | Exact commit identity, later commits observing earlier commits, history-preserving correction | Conceptual technique only. No Git implementation code or authentication claim is imported.                                                                       |
| in-toto Statement model (in-toto project, Apache-2.0)                                             | Typed subjects/digests and predicates for external run observations                           | Not adopted in tracer 0001. Workgraph keeps its smaller frozen reference families; a future adapter may translate an externally observed statement.              |
| Event-sourcing literature, including Martin Fowler's event-sourcing article (copyrighted article) | State derived from events and compensating/correcting history                                 | Conceptual technique only. The bounded reducer is project code, and no article text or implementation was copied.                                                |
| RFC 8785 JSON Canonicalization Scheme                                                             | Cross-runtime canonical JSON                                                                  | Not adopted. The tracer needs a bounded Bun/Node byte comparison, so its existing key-sorted serializer is smaller; it does not claim RFC 8785 conformance.      |
| Generic policy/rules engines                                                                      | Declarative policy dispatch                                                                   | Rejected for this tracer. A closed typed table makes accepted authority/category/edge/check-contract combinations directly reviewable without a new interpreter. |

## Bounded evidence and trust statements

- A valid Git object ID identifies an object within the stated repository
  identity. It does not establish authorship, review, signature validity, or
  availability from a trusted remote.
- Artifact digests identify bytes under the stated algorithm and media type.
  The tracer does not authenticate a locator or producing actor.
- A machine-check transition requires a passing zero-exit check whose exact
  subject and acceptance-contract identity match the named transition policy.
  This establishes only the bounded checker result as represented by the
  fixture.
- Human approval remains `human_approved_assertion` with
  `machine_checked: false`, including when an adapter reports stronger actor
  authentication.
- Imported records require an immutable observed revision in tracer 0001.
  Their interpretation remains provider-limited and does not automatically
  become a completion judgment.
- Graph-event references establish stable canonical event identity and
  supersession custody. The local typed fixture is not a tamper-resistant
  distributed store.
- The committed acceptance coverage view maps each frozen requirement to a
  command. It contains no run result. Exact-head run binding belongs to an
  external commit or CI observation.
- The unsupported-claim scan is a bounded lexical vocabulary check. It cannot
  establish the truth of arbitrary natural-language statements.
- The portable-core closure combines a relative-import allowlist with
  Oxlint's AST/scope-aware restricted-global rules. It covers the configured
  source closure and named ambient capabilities; it is not exhaustive
  information-flow analysis.
- Bun/Node parity establishes byte equality for the committed fixture journey
  in the observed run. It does not establish parity for all inputs or future
  runtimes.

## Deferred work

A general writable local store, signed reference verification, hosted
coordination, provider authentication, generic policy registration,
type-aware natural-language claims, exhaustive capability analysis, and
Semantic Systems adapters remain outside frozen tracer 0001.
