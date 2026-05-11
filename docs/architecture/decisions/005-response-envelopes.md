# ADR-005: Response Envelopes for Transport-Aware Results

**Status**: Implemented
**Date**: 2026-05-10

## Context

Operations from different sources produce results in fundamentally different shapes:

- **Local operations** return whatever the handler function returns — a plain value matching `outputSchema`
- **MCP operations** return `CallToolResult` — `{ content: ContentBlock[], structuredContent?: Record<string, unknown>, isError?: boolean }`
- **OpenAPI (HTTP) operations** return raw HTTP response bodies — parsed JSON, text, or `ArrayBuffer`, with no metadata about the HTTP transaction itself

Currently, all three are treated identically: `outputSchema: Type.Unknown()` for MCP, and OpenAPI handlers return whatever `response.json()` / `.text()` / `.arrayBuffer()` produces. There is no way for consumers to:

1. Know what kind of source produced the result
2. Access transport metadata (HTTP status, MCP error flags, content type)
3. Distinguish structured vs. unstructured content within the same result
4. Compose operations across sources — only local handlers return types matching their declared `outputSchema`
5. Access the typed data that MCP tools with `outputSchema` can provide (MCP spec 2025-06-18+)

This composability gap forces each consumer to write adapter-specific unwrapping logic, defeating the purpose of a unified registry.

### The composability spectrum

Composability — the ability to call an operation and get data matching `outputSchema` regardless of source — depends on whether the source provides schema information:

- **Local operations**: Fully composable. Handler returns a value, infrastructure validates against `outputSchema`.
- **MCP operations with `outputSchema`** (spec 2025-06-18+): Composable. The tool declares its output schema at discovery time. `structuredContent` contains data matching that schema. The adapter can convert the MCP `outputSchema` to TypeBox and set it on the operation.
- **MCP operations without `outputSchema`**: Not composable. `outputSchema` is `Type.Unknown()`. The result is `MCPContentBlock[]` — unstructured content that must be interpreted heuristically. Many MCP servers return `JSON.stringify`'d text in content blocks rather than structured output.
- **OpenAPI operations**: Composable to the extent the spec's response schema is accurate. The adapter converts the OpenAPI response schema to TypeBox for `outputSchema`.

The envelope design targets the common cases (local + MCP with `outputSchema` + OpenAPI) and provides metadata for the uncommon cases (MCP without `outputSchema`).

## Decision

Introduce a `ResponseEnvelope<T>` type that wraps every operation result with source metadata. Every `execute()` call and every `call.responded` event carries a `ResponseEnvelope`. Adapters produce envelopes via factory functions; local handlers return raw values that the infrastructure wraps.

### Envelope shape

```ts
interface ResponseEnvelope<T = unknown> {
  data: T
  meta: ResponseMeta
}

type ResponseMeta = LocalResponseMeta | HTTPResponseMeta | MCPResponseMeta
```

- `data` holds the operation output — always in the same place regardless of source
- `meta` carries transport-specific metadata, discriminated on `source`

### Where wrapping happens

- **Local handlers** return raw values. `OperationRegistry.execute()` and `CallHandler` detect raw values and wrap them in `localEnvelope()`
- **MCP handlers** return `mcpEnvelope(...)` — they construct the envelope because they have the MCP-specific metadata
- **OpenAPI handlers** return `httpEnvelope(...)` — they construct the envelope because they have the HTTP response metadata
- **Detection**: `isResponseEnvelope()` checks for `meta.source` being a known source string. If the handler already returned an envelope, the infrastructure passes it through

### Handler responsibility shift

Currently, handlers in the call protocol are expected to publish `call.responded` themselves. This creates ambiguity about who owns envelope construction. After this change:

- **Handlers return values** — they don't publish events. Local handlers return raw values; adapter handlers return envelopes
- **`CallHandler` (and `execute()`) wraps and publishes** — they call the handler, detect whether the result is already an envelope, wrap if needed, validate `envelope.data` against `outputSchema`, and publish `call.responded`

### API surface changes

| API | Before | After |
|-----|--------|-------|
| `registry.execute()` return | `Promise<TOutput>` | `Promise<ResponseEnvelope<TOutput>>` |
| `callMap.call()` resolve | `unknown` | `ResponseEnvelope` |
| `call.responded.output` | `Type.Unknown()` | `ResponseEnvelopeSchema` |
| Local handler return | raw value (unchanged) | raw value (infrastructure wraps) |
| MCP handler return | `ContentBlock[]` | `mcpEnvelope(...)` |
| OpenAPI handler return | raw parsed body | `httpEnvelope(...)` |
| `outputSchema` validation target | raw return value | `envelope.data` |
| `subscribe()` yield | raw value | `ResponseEnvelope` per yield |
| `OperationEnv` function return | `Promise<unknown>` | `Promise<ResponseEnvelope>` |

These are **breaking changes**. The package is pre-1.0, the call protocol is draft status, and the consumers (alkhub, opencode) are under our control. There is no transitional API — a single-release breaking change.

## Rationale

### Why `data` + discriminated `meta`

Several designs were considered:

1. **Discriminated union per source** — `{ type: "mcp", ...mcpFields } | { type: "http", ...httpFields } | { type: "local", data: T }` — puts the actual output in a different property per source, requiring source dispatch to get the data
2. **Generic envelope with typed meta** — `{ data: T, meta: ResponseMeta }` where `ResponseMeta` is discriminated on `source`
3. **Adapter-specific envelopes** — each adapter defines its own output type, no shared interface

Option 2 (chosen) keeps `data` in a predictable location regardless of source. The 90% case (just get the result) is `envelope.data`. The 10% case (inspect transport details) checks `envelope.meta.source` and narrows. Adding new sources means adding a new variant to `ResponseMeta`, not restructuring the envelope.

### Why `execute()` always returns `ResponseEnvelope`

A `execute()` that returns `TOutput | ResponseEnvelope<TOutput>` would require every call site to check. A `execute()` that returns `TOutput` for local ops and `ResponseEnvelope<TOutput>` for adapter ops is unpredictable. Always returning `ResponseEnvelope` gives a uniform interface: consumers always know the shape, `unwrap()` is always available for the simple path, and metadata is always accessible.

### Composability and `outputSchema`

The core composability problem is that only local operations reliably return types matching their declared `outputSchema`. With envelopes, composability depends on whether the source provides schema information:

- **Local operations**: `envelope.data` always matches `outputSchema` — the handler returns a value that the infrastructure validates against the schema.
- **MCP operations with `outputSchema`** (spec 2025-06-18+): The MCP tool declares an `outputSchema` at discovery time. The `from_mcp` adapter can convert this to a TypeBox schema and set it as the operation's `outputSchema`. At call time, `structuredContent` contains data validated against that schema, so `envelope.data` matches `outputSchema`. These operations are fully composable. The `Value.Cast()` function from `@alkdev/typebox/value` can further normalize `structuredContent` against the TypeBox schema, stripping excess properties and filling defaults — ensuring `envelope.data` cleanly matches the declared type, just like local operations.
- **MCP operations without `outputSchema`** (pre-2025-06-18 or tools that don't declare it): `outputSchema` is `Type.Unknown()`. `envelope.data` is `MCPContentBlock[]` (the raw content blocks). No composability — the consumer must inspect the content blocks.
- **OpenAPI operations**: `outputSchema` is derived from the OpenAPI spec's response schema. `envelope.data` contains the parsed response body. These are composable to the extent the OpenAPI spec's response schema is accurate.

For MCP, composability improves as more servers adopt `outputSchema`. The `from_mcp` adapter should extract and use `outputSchema` when available (see integration points in the spec document).

### Why handlers don't publish `call.responded`

The current model has handlers calling `callMap.respond()` directly, which means they must manually construct and send the event. This is error-prone and makes it unclear who is responsible for envelope construction. By having handlers return values and having the infrastructure (CallHandler, execute) own wrapping and publishing, there is a single point of envelope construction and event emission.

### Why MCP `isError: true` doesn't throw

MCP distinguishes between "the tool call failed at the protocol level" (transport error, tool not found — these throw `CallError`) and "the tool ran but returned an error result" (`isError: true` in `CallToolResult`). The latter is still useful content — the consumer may want to display the error text, log it, or take corrective action. Wrapping it in an envelope with `meta.isError: true` preserves this content while giving consumers a clear way to distinguish error results from success results.

### Why string discriminant for envelope detection

Three approaches were considered for detecting whether a handler return value is already a `ResponseEnvelope`:

1. **Duck-typing** — check for `data` + `meta` properties. Risk: false positives on user data that happens to have those properties.
2. **`Symbol.for()` / `Symbol()` brand** — a branded property that marks an object as an envelope. `Symbol.for()` has cross-realm issues (iframes, workers). `Symbol()` requires exporting/importing the symbol, creating import coupling for adapters.
3. **Closed-set string discriminant** — check `meta.source` against `["local", "http", "mcp"]`. JSON-serializable, cross-realm safe, no import coupling. Low false-positive risk because the source strings are under our control.

Option 3 was chosen. See [response-envelopes.md § Detection](../response-envelopes.md#detection) for the implementation.

## Consequences

- All `execute()` consumers must access `.data` on the result or use `unwrap()`
- All `call.responded` event consumers must expect `ResponseEnvelope` instead of `unknown`
- Handlers that currently call `callMap.respond()` must be updated to return values instead
- MCP adapters must use `mcpEnvelope()` instead of returning `ContentBlock[]` directly
- OpenAPI adapters must use `httpEnvelope()` instead of returning raw response data
- `outputSchema` continues to describe the business data shape (`envelope.data`), not the envelope itself
- The envelope shape is JSON-serializable (important for pubsub over Redis/WebSocket)
- New metadata sources require adding a variant to `ResponseMeta` and updating `RESPONSE_SOURCES`
- MCP operations with `outputSchema` (2025-06-18+ spec) become composable with local operations — `envelope.data` matches the TypeBox-converted `outputSchema`. `Value.Cast()` from `@alkdev/typebox/value` can further normalize `structuredContent` against the schema, stripping excess properties and filling defaults
- MCP operations without `outputSchema` remain non-composable — `envelope.data` is `MCPContentBlock[]` and `outputSchema` is `Type.Unknown()`

## Out of Scope

This ADR does **not** cover:

- **Envelope transformation/middleware chains** — no support for intercepting or transforming envelopes between handler and consumer
- **Envelope caching** — envelopes are not cache keys or cached values; caching is a consumer concern
- **Pagination via envelope metadata** — HTTP pagination cursors in headers are accessible via `meta.headers` but there is no built-in pagination abstraction
- **Envelope-based retry logic** — retry policies are a consumer concern, not an envelope concern
- **Serving direction** — envelopes cover consuming remote operations. When the operations package exposes operations *as* an MCP server or OpenAPI endpoint, the results must be wrapped in the protocol's format (MCP `CallToolResult`, HTTP response). This reverse direction is a separate concern.

A future "client" abstraction may address some of these patterns; see Open Questions in the spec document.

> **Note on ADR consolidation**: The original draft document contained 10 inline ADR sections (ADR-005 through ADR-014), each covering a sub-decision (envelope shape, MCP handling, HTTP handling, local handling, unwrap, call protocol changes, detection, outputSchema validation, client deferral). These have been consolidated into this single ADR because they constitute one coherent design decision — introducing response envelopes — with the individual trade-offs documented as rationale subsections. See [response-envelopes.md](../response-envelopes.md) for the full specification.