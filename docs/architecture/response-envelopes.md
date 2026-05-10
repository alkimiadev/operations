---
status: draft
last_updated: 2026-05-10
---

# Response Envelopes

> **Note**: This spec supersedes the current behavior described in [call-protocol.md](call-protocol.md) and [api-surface.md](api-surface.md). Those documents describe the pre-envelope model where `execute()` returns `TOutput` and handlers publish `call.responded` directly. The migration checklist below tracks the required updates. Until those documents are updated, this spec is the authoritative source for envelope behavior.

Types, factory functions, integration points, and constraints for the `ResponseEnvelope` system. See [ADR-005](decisions/005-response-envelopes.md) for the design rationale.

## Problem

Only locally-defined operations return types matching their declared `outputSchema`. MCP operations return `ContentBlock[]` (or `structuredContent` when the tool declares `outputSchema`), OpenAPI operations return raw HTTP response data, and there is no way for consumers to:

- Know what source produced a result
- Access transport metadata (HTTP status, MCP error flags)
- Compose operations across sources with a uniform interface
- Access typed data from MCP tools that declare `outputSchema` (spec 2025-06-18+)

See ADR-005 for the full problem statement, composability analysis, and rationale.

## Types

### `ResponseEnvelope`

```ts
interface ResponseEnvelope<T = unknown> {
  data: T
  meta: ResponseMeta
}
```

Universal result wrapper. `data` holds the operation output. `meta` carries transport-specific metadata, discriminated on `meta.source`.

### `ResponseMeta` (discriminated union)

```ts
type ResponseMeta = LocalResponseMeta | HTTPResponseMeta | MCPResponseMeta
type ResponseSource = "local" | "http" | "mcp"
```

### `LocalResponseMeta`

```ts
interface LocalResponseMeta {
  source: "local"
  operationId: string
  timestamp: number  // Unix epoch milliseconds (Date.now())
}
```

Minimal metadata for in-process operations. `operationId` is the full `namespace.name` key. `timestamp` is set at wrap time.

### `HTTPResponseMeta`

```ts
interface HTTPResponseMeta {
  source: "http"
  statusCode: number
  headers: Record<string, string>
  contentType: string
}
```

Preserves HTTP response metadata. Multi-value headers are joined with `, ` per the `fetch` `Headers` specification. This does not preserve `Set-Cookie` as a separate header — known limitation, can be extended to `Record<string, string | string[]>` if needed.

### `MCPResponseMeta`

```ts
interface MCPResponseMeta {
  source: "mcp"
  isError: boolean
  content: MCPContentBlock[]
  structuredContent?: Record<string, unknown>
  _meta?: Record<string, unknown>
}
```

Mirrors the MCP `CallToolResult` structure. Key semantics:

- `isError: true` means the tool ran but returned an error **result** — this is NOT a `CallError` exception. The handler wraps the result in an envelope. Consumers check `envelope.meta.isError` to distinguish error results from success results.
- `structuredContent` is the MCP structured output (spec version 2025-03-26+). When present, it is placed in `envelope.data` as the primary output.
- `content` always holds the full content block array, available in `meta` for rendering or fallback.
- `_meta` carries MCP protocol extensions.

### `MCPContentBlock`

```ts
type MCPContentBlock =
  | { type: "text"; text: string; annotations?: MCPAnnotations }
  | { type: "image"; data: string; mimeType: string; annotations?: MCPAnnotations }
  | { type: "audio"; data: string; mimeType: string; annotations?: MCPAnnotations }
  | { type: "resource"; resource: MCPResourceContent; annotations?: MCPAnnotations }
  | { type: "resource_link"; uri: string; name: string; description?: string; mimeType?: string }

interface MCPResourceContent {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

interface MCPAnnotations {
  audience?: Array<"user" | "assistant">
  priority?: number
  lastModified?: string
}
```

These types are our own definitions, decoupled from `@modelcontextprotocol/sdk`. The MCP adapter maps from SDK types to these types. This avoids coupling the main barrel to the MCP SDK runtime dependency.

## Detection

### `isResponseEnvelope()`

```ts
const RESPONSE_SOURCES = ["local", "http", "mcp"] as const

function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  if (typeof value !== "object" || value === null) return false
  const obj = value as Record<string, unknown>
  if (!("data" in obj) || !("meta" in obj)) return false
  if (typeof obj.meta !== "object" || obj.meta === null) return false
  return RESPONSE_SOURCES.includes((obj.meta as ResponseMeta).source as ResponseSource)
}
```

Used by `execute()` and `CallHandler` to detect whether a handler return value is already an envelope. Detection by `meta.source` discriminant is:

- JSON-serializable (works across pubsub transport boundaries)
- Cross-realm safe (no `Symbol.for()` iframe/Worker issues)
- Low false-positive risk (the known source strings are under our control)

If false positives become a concern, a versioned brand like `__envelopeVersion: 1` can be added to the envelope shape. New sources must be registered in `RESPONSE_SOURCES`.

## Factory Functions

Adapters and infrastructure use factory functions to construct envelopes. Adapters do not construct envelope objects directly.

```ts
function localEnvelope<T>(data: T, operationId: string): ResponseEnvelope<T> {
  return { data, meta: { source: "local", operationId, timestamp: Date.now() } }
}

function httpEnvelope<T>(data: T, meta: Omit<HTTPResponseMeta, "source">): ResponseEnvelope<T> {
  return { data, meta: { source: "http", ...meta } }
}

function mcpEnvelope<T>(data: T, meta: Omit<MCPResponseMeta, "source">): ResponseEnvelope<T> {
  return { data, meta: { source: "mcp", ...meta } }
}
```

- `localEnvelope` is used by `execute()` and `CallHandler` when wrapping raw handler return values
- `httpEnvelope` is used by the OpenAPI adapter handler
- `mcpEnvelope` is used by the MCP adapter handler
- `T` resolves to `undefined` for void handlers — `localEnvelope(undefined, opId)` is valid

## Utility

### `unwrap()`

```ts
function unwrap<T>(envelope: ResponseEnvelope<T>): T {
  return envelope.data
}
```

Convenience for the common case where metadata is not needed. Equivalent to `envelope.data`. Named for clarity at call sites and as a search target for envelope-unwrapping patterns.

## Schema Constants

TypeBox schemas for use in validation, spec definitions, and call protocol events:

```ts
const ResponseEnvelopeSchema = Type.Object({
  data: Type.Unknown({ description: "Operation output" }),
  meta: ResponseMetaSchema,
})

const ResponseMetaSchema = Type.Union([
  LocalResponseMetaSchema,
  HTTPResponseMetaSchema,
  MCPResponseMetaSchema,
])
```

Individual meta schemas (`LocalResponseMetaSchema`, `HTTPResponseMetaSchema`, `MCPResponseMetaSchema`, `MCPContentBlockSchema`) are defined inline in the source. See `src/response-envelope.ts` for the exact definitions.

## Integration Points

### `OperationRegistry.execute()`

Returns `Promise<ResponseEnvelope<TOutput>>` instead of `Promise<TOutput>`.

Flow:
1. Look up spec and handler (existing)
2. Validate input with `validateOrThrow` (existing)
3. Await handler result
4. If result `isResponseEnvelope()` → pass through as-is
5. Otherwise → wrap in `localEnvelope(result, operationId)`
6. Validate `envelope.data` against `spec.outputSchema` — warning-only, logged but not thrown
7. Return envelope

**Note**: `isResponseEnvelope()` does not validate that the envelope's `source` matches the operation's origin. An MCP handler that explicitly returns a `localEnvelope(...)` passes through as-is. Handlers that explicitly construct envelopes take responsibility for their metadata.

**Current source state** (`src/registry.ts` lines 80-105): `execute()` returns `Promise<TOutput>` directly. It does not wrap results in envelopes, does not call `isResponseEnvelope()`, and validates raw `result` against `outputSchema`. The `Value.Cast()` normalization step is not implemented. Changes needed:

| What | Current source | Target |
|------|---------------|--------|
| Return type | `Promise<TOutput>` | `Promise<ResponseEnvelope<TOutput>>` |
| Wrapping | None — returns raw `result` | `isResponseEnvelope(result) ? result : localEnvelope(result, operationId)` |
| Validation | `collectErrors(spec.outputSchema, result)` — on raw value | `collectErrors(spec.outputSchema, envelope.data)` — on envelope data |
| `Value.Cast()` | Not used | If `outputSchema !== Unknown`, `envelope.data = Value.Cast(spec.outputSchema, envelope.data)` |

### `CallHandler`

Takes full ownership of publishing `call.responded`. Handlers return values; they do NOT publish events.

Flow:
1. Look up spec and handler (existing)
2. Check access control (existing)
3. Validate input (existing)
4. Call handler and await result
5. If result `isResponseEnvelope()` → use directly
6. Otherwise → wrap in `localEnvelope(result, operationId)`
7. Validate `envelope.data` against `spec.outputSchema` — warning-only
8. Publish `call.responded` via `callMap.respond(requestId, envelope)`
9. On handler exception → publish `call.error` (existing). Note: an envelope with `meta.isError: true` does **not** trigger `call.error`. Only thrown exceptions do.

**Current source state** (`src/call.ts` lines 182-233): `buildCallHandler` calls `handler(input, context)` (line 226) but does not use the return value. The handler is expected to publish `call.responded` itself. Changes needed:

| What | Current source | Target |
|------|---------------|--------|
| Handler model | Handler publishes `call.responded` itself; return value ignored | Handler returns value; `CallHandler` wraps and publishes |
| Return value | `await handler(input, context)` called but result discarded | Result captured, wrapped in envelope if needed, then published |
| Envelope detection | Not applicable | `isResponseEnvelope(result)` check before wrapping |
| `call.responded.output` | `Type.Unknown()` | `ResponseEnvelopeSchema` |
| `PendingRequestMap.respond()` | Accepts any `unknown` value | Must enforce `isResponseEnvelope()` guard |

### `PendingRequestMap.respond()`

Enforces that `output` is a `ResponseEnvelope` via the `isResponseEnvelope()` type guard (not full schema validation). If called with a non-envelope value, throws. This prevents any code bypassing `CallHandler`'s envelope wrapping. A future iteration may make `respond()` internal (not exported on the public API surface) to further enforce this invariant.

**Current source state** (`src/call.ts` lines 151-156): `respond()` publishes `call.responded` with `output: unknown`. No envelope validation.

### `PendingRequestMap.call()`

Resolves with the `ResponseEnvelope` from `call.responded.output` instead of raw `unknown`.

**Current source state** (`src/call.ts` lines 120-149): `call()` returns `Promise<unknown>`. The type should become `Promise<ResponseEnvelope>`.

### `subscribe()`

Each yielded value is wrapped in `ResponseEnvelope`. `SubscriptionHandler` implementations still yield raw values — `subscribe()` wraps each yield, consistent with how local handlers return raw values and `execute()` wraps them. If a yielded value `isResponseEnvelope()`, it passes through. Otherwise, `localEnvelope(value, operationId)` with a fresh `timestamp` per yield.

### `buildEnv()`

Each function in the returned `OperationEnv` returns `Promise<ResponseEnvelope>` instead of `Promise<unknown>`.

### MCP Adapter (`from_mcp.ts`)

#### data shape and composability

MCP tool results have two shapes depending on whether the tool declares `outputSchema`:

- **With `outputSchema`** (MCP spec 2025-06-18+): `structuredContent` contains the typed output matching the tool's declared schema. The `from_mcp` adapter converts the tool's JSON Schema `outputSchema` to a TypeBox schema via `FromSchema` and sets it as the operation's `outputSchema`. At call time, `envelope.data` is `structuredContent`, which matches `outputSchema`. These operations are **fully composable** with local operations — the consumer gets typed data just like calling a local handler.

- **Without `outputSchema`**: No typed output is available. The operation's `outputSchema` is `Type.Unknown()`. `envelope.data` is `MCPContentBlock[]` (the raw content blocks). These operations are **not composable** — the consumer must inspect content blocks heuristically. Some MCP servers return `JSON.stringify`'d text in content blocks rather than structured output, making programmatic consumption even harder.

When `structuredContent` is present, it is the primary data path. When absent, `content` is the only data path. This means `envelope.data` has a different shape depending on the MCP server version and tool configuration. Consumers that need a consistent shape should check `meta.source === "mcp"` and `meta.structuredContent` to determine the access pattern.

#### outputSchema extraction

The `from_mcp` adapter SHOULD extract `outputSchema` from MCP tool definitions (when available) and convert it to a TypeBox schema:

```ts
// In createMCPClient, when building the operation spec:
outputSchema: tool.outputSchema
  ? FromSchema(tool.outputSchema)   // Convert JSON Schema to TypeBox
  : Type.Unknown()                   // No schema available
```

This enables `outputSchema` validation on `envelope.data` for MCP operations that declare their output schema, making them composable with local operations.

#### Envelope stripping with `Value.Cast()`

When an MCP operation has `outputSchema` and returns `structuredContent`, the `structuredContent` data can be cast against the TypeBox schema to strip excess properties and normalize it:

```ts
import { Value } from "@alkdev/typebox/value"

// In the MCP handler, after getting structuredContent:
const data = result.structuredContent
  ? Value.Cast(spec.outputSchema, result.structuredContent)
  : mapMCPContentBlocks(result.content)
```

`Value.Cast()` upcasts the `structuredContent` value into the target type, retaining matching properties, filling defaults for missing ones, and stripping properties not in the schema. This ensures `envelope.data` reliably matches `outputSchema` — the same guarantee that local operations provide.

For MCP operations without `outputSchema` (where `outputSchema` is `Type.Unknown()`), `Value.Cast()` against `Type.Unknown()` is a no-op (accepts any value), so the data shape remains unpredictable. The composability gap exists only for these operations.

This same pattern applies to OpenAPI responses: the parsed JSON can be passed through `Value.Cast(spec.outputSchema, data)` to normalize it against the operation's `outputSchema`.

#### Handler behavior change

```ts
handler: async (input, context) => {
  const result = await client.callTool({ name, arguments: input })
  // MCP isError: true means the tool ran but returned an error result.
  // Wrap in envelope — consumer checks meta.isError.
  // Transport-level errors (tool not found, connection failure) still throw CallError.
  return mcpEnvelope(
    result.structuredContent ?? mapMCPContentBlocks(result.content),
    {
      isError: result.isError ?? false,
      content: mapMCPContentBlocks(result.content),
      structuredContent: result.structuredContent as Record<string, unknown> | undefined,
      _meta: result._meta as Record<string, unknown> | undefined,
    },
  )
}
```

Key differences from current behavior:
- `isError: true` no longer throws. Error content is accessible via `envelope.data` and `envelope.meta.content`. The consumer checks `envelope.meta.isError`.
- `structuredContent` is preferred as `data` when available (MCP spec 2025-03-26+)
- Raw `content` blocks are always available in `meta.content`
- `mapMCPContentBlocks()` maps SDK `ContentBlock[]` to our `MCPContentBlock[]` (1:1 field mapping, decoupling us from the MCP SDK at the interface level). Signature: `(sdkBlocks: SDKContentBlock[]) => MCPContentBlock[]`. Unknown content block types (from newer MCP spec versions that our `MCPContentBlock` union doesn't yet cover) are mapped to `{ type: "text", text: JSON.stringify(block) }` as a fallback — preserving the data without crashing.

### OpenAPI Adapter (`from_openapi.ts`)

Handler behavior change:

```ts
handler: async (input, context) => {
  // ... existing URL construction and fetch logic ...
  const response = await fetch(url, fetchOptions)

  if (!response.ok) {
    throw new CallError("EXECUTION_ERROR", `HTTP ${response.status}: ${response.statusText}`)
  }

  const contentType = response.headers.get("Content-Type") || ""
  let data: unknown
  if (contentType.includes("application/json")) {
    data = await response.json()
  } else if (contentType.includes("text/")) {
    data = await response.text()
  } else {
    data = await response.arrayBuffer()
  }

  return httpEnvelope(data, {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    contentType,
  })
}
```

- On HTTP error status → throw `CallError` (not an envelope — these are transport errors)
- Success responses → wrapped in `httpEnvelope` with full HTTP metadata
- Headers are a `Record<string, string>` snapshot (multi-value headers joined with `, ` per fetch spec)

### Value.Cast() for Data Normalization

When an adapter has a meaningful `outputSchema` (not `Type.Unknown()`), `Value.Cast()` from `@alkdev/typebox/value` can normalize `envelope.data` against the schema:

```ts
import { Value } from "@alkdev/typebox/value"

// In execute(), after wrapping the result:
if (!isResponseEnvelope(result)) {
  envelope = localEnvelope(result, operationId)
} else {
  envelope = result
}

// Normalize data against outputSchema (when schema is meaningful)
if (spec.outputSchema[Kind] !== "Unknown") {
  envelope.data = Value.Cast(spec.outputSchema, envelope.data)
}
```

This strips excess properties, fills defaults for missing ones, and upcasts values to match the declared type. For local operations, this provides the same guarantee as `Value.Check()` validation but with normalization instead of just warning. For MCP operations with `outputSchema`, it strips envelope-like properties that MCP servers might add beyond the declared schema. For OpenAPI operations, it normalizes the response body against the spec.

Operations with `Type.Unknown()` `outputSchema` (typically MCP tools without `outputSchema`) are excluded — `Value.Cast()` against `Type.Unknown()` is a no-op.

### `CallEventSchema`

`call.responded.output` changes from `Type.Unknown()` to `ResponseEnvelopeSchema`:

```ts
"call.responded": Type.Object({
  requestId: Type.String(),
  output: ResponseEnvelopeSchema,
})
```

## `outputSchema` and Validation

`outputSchema` on `OperationSpec` validates `envelope.data`, not the full `ResponseEnvelope`. The envelope has its own `ResponseEnvelopeSchema` for call protocol validation. This keeps `outputSchema` focused on business data shape — no envelope schema bloat, and existing `outputSchema` definitions don't need changes.

There are two validation/normalization steps for `envelope.data`:

1. **Warning validation** (`collectErrors` + `formatValueErrors`): Checks `envelope.data` against `spec.outputSchema` and logs warnings on mismatch. This is the existing behavior in `execute()`.
2. **Data normalization** (`Value.Cast`): When `outputSchema` is meaningful (not `Type.Unknown()`), `Value.Cast(spec.outputSchema, envelope.data)` normalizes the data — strips excess properties, fills defaults for missing ones, upcasts values to match the declared type. This is particularly important for MCP `structuredContent` (which may contain extra properties from the MCP envelope) and OpenAPI response bodies (which may have extra fields not in the spec).

The `Value.Cast()` step is optional: if `outputSchema` is `Type.Unknown()`, normalization is skipped (any value is accepted). This preserves the current behavior for MCP tools without `outputSchema`.

## Constraints

1. **No runtime envelope overhead for local handlers** — local handlers return raw values; wrapping happens in infrastructure (`execute()`, `CallHandler`), not in user code
2. **Envelope always present at call protocol boundary** — `call.responded` always carries `ResponseEnvelope`, never raw values. `PendingRequestMap.respond()` enforces this.
3. **Adapters use factory functions** — `localEnvelope()`, `httpEnvelope()`, `mcpEnvelope()`. Adapters do not construct envelope objects directly.
4. **MCPContentBlock types are our own** — not MCP SDK types. Avoids runtime dependency on `@modelcontextprotocol/sdk` in the main barrel.
5. **Breaking change: single-release, no transitional API** — `execute()` return type and `call.responded` shape change in one release. Package is pre-1.0, call protocol is draft, consumers are coordinated.
6. **`unwrap()` is the simple-path API** — for consumers that don't need metadata
7. **`outputSchema` validates `envelope.data`** — `ResponseEnvelopeSchema` validates the envelope structure; `outputSchema` validates business data
8. **`isResponseEnvelope()` is the sole detection mechanism** — no Symbol brands, no duck-typing beyond the closed `source` discriminant set

## Open Questions

1. **Client abstraction** — Envelopes provide metadata and `unwrap()` provides simple access, but real usage may reveal patterns that justify a higher-level abstraction: e.g., a client that auto-handles MCP `isError` results (throwing on error content vs. returning it), or one that extracts pagination cursors from HTTP headers. Deferred until usage patterns from alkhub and opencode confirm whether `unwrap()` + `meta.source` dispatch is sufficient or whether a typed "client" per source adds real value.

2. **Subscription envelopes** — `subscribe()` wraps each yield in `ResponseEnvelope`. For long-running subscriptions, `localResponseMeta.timestamp` updates per yield. Whether subscriptions need additional metadata (e.g., sequence numbers, cursor positions) is an open question for future iteration.

3. **`respond()` visibility** — Currently public on `PendingRequestMap`. After CallHandler takes ownership of publishing, `respond()` may become internal-only to enforce the envelope invariant.

4. **Envelope directionality (serving)** — The current design covers **consuming** remote operations (MCP, OpenAPI) and wrapping their results. The reverse direction — **serving** local operations via MCP or OpenAPI — is not yet addressed. When exposing operations as an MCP server, results must be wrapped in MCP's `CallToolResult` format (`structuredContent` + `content`). When exposing as OpenAPI, results must be serialized as HTTP response bodies. How envelopes interact with this serving direction is an open design question.

5. **JSON.stringify in MCP content blocks** — Some MCP servers return `JSON.stringify`'d data in text content blocks instead of using `structuredContent`. The `from_mcp` adapter could attempt `JSON.parse()` on text content when `structuredContent` is absent, but this is fragile (not all text content is JSON). If the operation has a meaningful `outputSchema`, `Value.Cast()` could normalize the parsed result against the schema, making the consumer's experience consistent regardless of whether the MCP server uses `structuredContent` or stringified JSON. Whether this JSON.parse heuristic belongs in the adapter or in consumer code is unresolved.

6. **MCP `outputSchema` extraction completeness** — The MCP spec (2025-06-18+) allows tools to declare `outputSchema`, but many existing servers don't. The adapter's `FromSchema` conversion of MCP `outputSchema` to TypeBox may encounter JSON Schema features that `FromSchema` doesn't handle. The fallback is `Type.Unknown()`, same as the no-schema case.

## Migration Checklist

When this spec stabilizes, the following documents and code must be updated:

| Document | Section | Change |
|----------|---------|--------|
| `call-protocol.md` | CallHandler | Handler no longer publishes `call.responded`; returns values. CallHandler wraps and publishes. |
| `call-protocol.md` | PendingRequestMap | `respond()` validates envelope via `isResponseEnvelope()`; resolves with `ResponseEnvelope` instead of `unknown` |
| `call-protocol.md` | CallEventMap | `call.responded.output` changes from `Type.Unknown()` to `ResponseEnvelopeSchema` |
| `api-surface.md` | `execute()` | Return type: `Promise<TOutput>` → `Promise<ResponseEnvelope<TOutput>>` |
| `api-surface.md` | `PendingRequestMap.call()` | Resolve type: `unknown` → `ResponseEnvelope` |
| `api-surface.md` | `subscribe()` | Yield type: `unknown` → `ResponseEnvelope` |
| `api-surface.md` | `OperationEnv` | Inner function return type: `Promise<unknown>` → `Promise<ResponseEnvelope>` |
| `api-surface.md` | `CallHandler` | New: wraps handler result, publishes `call.responded`. No longer "handler publishes" model. |
| `call-protocol.md` | `PendingRequestMap.respond()` | Now enforces `isResponseEnvelope()` check — throws on raw values. Behavioral breaking change. |
| `api-surface.md` | `PendingRequestMap.respond()` | Same — `respond()` now requires `ResponseEnvelope` argument. |
| `adapters.md` | `from_mcp` | Handler returns `mcpEnvelope()`. MCP `isError: true` no longer throws. |
| `adapters.md` | `from_mcp` | `outputSchema` extracted from MCP tool definitions when available (2025-06-18+ spec), converted via `FromSchema`. Falls back to `Type.Unknown()`. |
| `adapters.md` | `from_openapi` | Handler returns `httpEnvelope()`. Error on HTTP error status still throws `CallError`. |

Additionally, any code subscribing to `"call.responded"` events via the pubsub system (not just `PendingRequestMap`, but any direct pubsub consumer) must expect `ResponseEnvelope` instead of `unknown` in the event payload.

## References

- [ADR-005](decisions/005-response-envelopes.md) — Design rationale for response envelopes
- [call-protocol.md](call-protocol.md) — Call event shapes, PendingRequestMap, CallHandler
- [api-surface.md](api-surface.md) — Public API surface
- [adapters.md](adapters.md) — MCP and OpenAPI adapter internals