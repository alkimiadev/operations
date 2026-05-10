---
status: draft
last_updated: 2026-05-10
---

# Response Envelopes

How adapter-produced operations wrap their outputs in structured envelopes, how consumers unwrap them, and how the call protocol carries envelope information through the event layer.

## Problem

Every adapter produces operation results in a different wire format:

- **MCP** returns `CallToolResult` — `{ content: ContentBlock[], structuredContent?: Record<string, unknown>, isError?: boolean }` where `ContentBlock` is a discriminated union (`text`, `image`, `audio`, `resource`).
- **OpenAPI (HTTP)** returns raw HTTP response bodies — `application/json` → parsed JSON, `text/*` → string, or `ArrayBuffer` for binary. There is no envelope; error information is in the HTTP status code.
- **Local operations** return whatever the handler function returns — a plain value matching `outputSchema`.

Currently the codebase treats all three identically: `outputSchema: Type.Unknown()` for MCP, and for OpenAPI the handler just returns whatever `response.json()` / `.text()` / `.arrayBuffer()` produces. There is no unified way for consumers to:

1. Know *what kind of thing* produced the result (MCP tool? HTTP call? local handler?)
2. Access metadata about the response (HTTP status, content type, MCP error flags)
3. Distinguish structured vs. unstructured content within the same result
4. Handle multi-content responses (MCP arrays) vs. single-value responses (local ops)

This gap forces each consumer to write adapter-specific unwrapping logic, which defeats the purpose of a unified registry.

## Design Decisions

### ADR-005: Response Envelope as a First-Class Concept

**Context**: Operations from different sources produce results in fundamentally different shapes. The registry treats them all as `unknown` output, losing structural information that consumers need.

**Decision**: Introduce a `ResponseEnvelope` type that wraps every operation result with transport metadata. Adapters produce envelopes; consumers unwrap or inspect them.

**Trade-offs**:
- (+) Consumers get a uniform interface regardless of operation source
- (+) Envelope-preserving handlers can pass through metadata (HTTP status, MCP content blocks) without losing it
- (+) Error metadata (MCP `isError`, HTTP status codes) is accessible without ad-hoc conventions
- (−) Adds a wrapping layer for local operations that don't need it
- (−) Requires all existing consumers to decide: unwrap or carry the envelope

**Rationale**: The benefit of uniform access outweighs the wrapping cost. Local operations get the simplest envelope (`{ data, meta: { source: "local" } }`); adapters add their own metadata. Consumers that don't care about metadata can use `unwrap()`.

---

### ADR-006: Envelope Structure — Flat Data + Typed Metadata

**Context**: Several envelope designs were considered:

1. **Discriminated union per source** — `{ type: "mcp", ...mcpFields } | { type: "http", ...httpFields } | { type: "local", data: T }`
2. **Generic envelope with typed meta** — `{ data: T, meta: ResponseMeta }` where `ResponseMeta` is a discriminated union
3. **Adapter-specific envelope per adapter** — each adapter defines its own output type

**Decision**: Option 2 — a generic `ResponseEnvelope<T>` with a `data` field for the actual result and a `meta` field carrying transport-specific metadata.

```ts
interface ResponseEnvelope<T = unknown> {
  data: T
  meta: ResponseMeta
}

type ResponseMeta =
  | LocalResponseMeta
  | HTTPResponseMeta
  | MCPResponseMeta
```

**Trade-offs**:
- (+) Single type to pattern-match on, one `meta.source` to dispatch
- (+) `data` is always in the same place regardless of source
- (+) Easy to add new metadata variants without changing the envelope shape
- (−) `meta` must be discriminated on `source` for type narrowing
- (−) Local operations add a trivially-simple envelope

**Rationale**: Having `data` in a predictable location makes the 90% case (just get the result) simple. `meta` is for the 10% case (inspect transport details). A discriminated union on `source` gives typed access to each variant's fields.

---

### ADR-007: MCP Output Handling — `structuredContent` First

**Context**: MCP `CallToolResult` has two result fields:
- `content: ContentBlock[]` — unstructured array of text/image/audio/resource blocks
- `structuredContent?: Record<string, unknown>` — structured output matching the tool's `outputSchema` (MCP spec version 2025-03-26+)

When `structuredContent` is present, it is the typed, schema-conforming output. When absent, only `content` is available and must be interpreted heuristically.

**Decision**: The MCP adapter will:

1. If `structuredContent` is present → use it as `data` in the envelope, `Type.Unknown()` remains the `outputSchema` (since we can't reliably map MCP's JSON Schema output to TypeBox at tool-discovery time)
2. If `structuredContent` is absent → use `content` as `data` (the `MCPContentBlock[]` array)
3. Always include the full `CallToolResult` metadata in `meta` (`isError`, `_meta`, full `content` array)
4. If `isError: true` → the tool ran but returned an error result. The handler wraps the result in an envelope with `meta.isError: true` and **does not throw**. This preserves the error content for the consumer. This differs from protocol-level errors (tool not found, transport failure) which still throw `CallError`.

The `outputSchema` on MCP-generated operations remains `Type.Unknown()` because MCP does not provide output schemas at tool-listing time, and even with `structuredContent` the schema validation would need to happen at call time.

**Trade-offs**:
- (+) Consumers get preferential access to structured output when available
- (+) The raw content blocks are still in `meta` for rendering or fallback
- (+) Matches MCP spec intent: `structuredContent` is the programmatically-usable output
- (+) Error results are accessible to consumers — MCP `isError` doesn't always mean a call failure
- (−) The shape of `data` changes based on whether `structuredContent` is present
- (−) `outputSchema` can't reflect this dynamically
- (−) Consumers must check `meta.isError` for MCP operations, whereas they check thrown exceptions for other sources

**Rationale**: MCP is moving toward `structuredContent` as the primary output channel. Prioritizing it positions us correctly. The fallback to `content` handles older servers. Since `outputSchema` is already `Type.Unknown()` for MCP ops, the variability is acceptable. Not throwing on `isError: true` preserves the MCP semantic where error results are still useful content, not call failures.

---

### ADR-008: HTTP Response Envelope — Preserve Transport Metadata

**Context**: The OpenAPI adapter currently returns raw deserialized response bodies with no metadata about the HTTP transaction itself. Consumers that need HTTP status codes, headers, or content-type information have no way to access them.

**Decision**: The OpenAPI adapter handler will return a `ResponseEnvelope` with `HTTPResponseMeta`:

```ts
interface HTTPResponseMeta {
  source: "http"
  statusCode: number
  headers: Record<string, string>
  contentType: string
}
```

- `data` contains the parsed response body (JSON object, string, or ArrayBuffer — unchanged from current behavior)
- `statusCode` preserves the HTTP status code
- `headers` captures response headers for downstream use (pagination links, rate limits, etc.)
- `contentType` records the original content type

**Known limitation**: `headers` is `Record<string, string>` which does not preserve multi-value headers or `Set-Cookie`. For APIs that use these, headers with the same key are joined with `, ` (following the `fetch` `Headers` specification). This is a deliberate simplification; if multi-value headers become critical, the type can be extended to `Record<string, string | string[]>`.

**Trade-offs**:
- (+) Consumers can make decisions based on HTTP metadata (pagination, caching, error differentiation)
- (+) No information is lost from the HTTP response (within the single-value header limitation)
- (−) Breaking change from the current raw return value
- (−) Headers map is a snapshot; streaming headers are not supported
- (−) Multi-value headers (especially `Set-Cookie`) are collapsed

**Rationale**: HTTP responses carry essential metadata. Losing it in an adapter that's supposed to expose the full capability of the underlying protocol is a design flaw. The envelope preserves this with minimal overhead. The multi-value header limitation can be addressed in a future iteration if needed.

---

### ADR-009: Local Operations Get Minimal Envelopes

**Context**: Local operations (registered directly in-process) return plain values from their handlers. Forcing them to wrap in `ResponseEnvelope` would be ergonomically poor.

**Decision**: Local operation handlers return raw values. `OperationRegistry.execute()` and `CallHandler` automatically wrap raw values in a minimal `ResponseEnvelope` with `LocalResponseMeta`:

```ts
interface LocalResponseMeta {
  source: "local"
  operationId: string
  timestamp: number  // Unix epoch milliseconds (Date.now())
}
```

This means consumers of `execute()` and call protocol responses always receive `ResponseEnvelope`, regardless of whether the operation came from MCP, HTTP, or local code.

For handlers that return `void` or `undefined`, the envelope wraps `data: undefined`. The envelope is still produced — `data` is `undefined` and `meta` contains the operation metadata.

**Trade-offs**:
- (+) Uniform result type for all consumers — no adapter-specific code needed
- (+) Handlers stay simple — return raw values
- (+) Call protocol events naturally carry envelope data
- (−) Local envelope wrapping adds a thin layer that may seem unnecessary for in-process calls
- (−) Call protocol events currently have `output: unknown`; changing this to `output: ResponseEnvelope` is a breaking change

**Rationale**: The uniform interface is worth the thin wrapping layer. Most code just calls `envelope.data` and moves on. Code that cares about transport metadata inspects `envelope.meta`.

---

### ADR-010: `unwrap()` Utility for Simple Consumption

**Context**: Most consumers don't care about transport metadata. They just want the output value.

**Decision**: Provide an `unwrap()` utility:

```ts
function unwrap<T>(envelope: ResponseEnvelope<T>): T {
  return envelope.data
}
```

This is literally `envelope.data`. It exists as a named function for documentation purposes and to make intent explicit at call sites.

**Trade-offs**:
- (+) Clear intent at call sites: `unwrap(result)` is self-documenting
- (+) Easy to search for — all envelope-unwrapping sites are explicit
- (+) Provides a place to add validation or transformation logic later if needed
- (−) It's just property access; some may find it unnecessary

**Rationale**: The cost is near-zero and the clarity benefit is real. It future-proofs the API for when envelope handling might need to evolve.

---

### ADR-011: Call Protocol Breaking Change and Handler Responsibility Shift

**Context**: The `call.responded` event currently has `{ requestId, output: unknown }`. With envelopes, `output` should carry a `ResponseEnvelope`. This is a breaking change for all call protocol consumers. Additionally, the current architecture has handlers publishing `call.responded` themselves, which creates an ambiguity about who is responsible for wrapping.

**Decision — Breaking change**: `call.responded.output` changes from `unknown` to `ResponseEnvelope`. This is a single-release breaking change — there is no transitional API. The call protocol is in draft status, the package is pre-1.0, and the consumers (alkhub, opencode) are under our control.

**Decision — Handler responsibility shift**: `CallHandler` becomes the sole publisher of `call.responded`. Handlers always return their result value (either raw or a `ResponseEnvelope`). `CallHandler`:
1. Validates input and checks access control (existing behavior)
2. Calls `handler(input, context)`
3. Wraps the return value in a `ResponseEnvelope` if it isn't one already
4. Publishes `call.responded` via `callMap.respond(requestId, envelope)`
5. On error, publishes `call.error` (existing behavior)

This eliminates the current pattern where handlers must publish `call.responded` themselves. Handlers that currently call `callMap.respond()` directly must be updated to return values instead.

**Migration impact**:
- `execute()` return type: `Promise<TOutput>` → `Promise<ResponseEnvelope<TOutput>>`
- `callMap.call()` resolve value: `unknown` → `ResponseEnvelope`
- `call.responded.output`: `unknown` → `ResponseEnvelope`
- Handler contract: handlers return values, they do NOT publish events
- Consumers that do `const result = await registry.execute(...)` must change to `const envelope = await registry.execute(...)` and access `envelope.data` or use `unwrap()`

**Trade-offs**:
- (+) Clear single responsibility: `CallHandler` wraps and publishes, handlers compute
- (+) Every `call.responded` event is guaranteed to carry a `ResponseEnvelope`
- (+) No ambiguity about who handles envelope construction
- (−) Breaking change for all call protocol consumers — no transitional period
- (−) Handlers that currently publish `call.responded` must be refactored to return values
- (−) `execute()` callers must adapt to envelope return type

**Rationale**: Having a single, clear ownership model for event publishing and envelope wrapping eliminates the ambiguity entirely. The breaking change is contained and the consumers are known and coordinated. A transitional API would add complexity for no long-term benefit.

---

### ADR-012: Envelope Detection via Discriminant

**Context**: When `execute()` or `CallHandler` receives a handler return value, it needs to determine whether it's already a `ResponseEnvelope` or a raw value that needs wrapping.

Initially, duck-typing (`data` + `meta` + `meta.source` is a string) was considered, but this has a false-positive risk on user data that happens to have those properties. A `Symbol` brand was then considered, but `Symbol.for()` has cross-realm issues (iframes, workers) and `Symbol()` requires exporting for adapters, creating a coupling point.

**Decision**: Use a plain string discriminant. A `ResponseEnvelope` is detected by checking for `meta.source` being one of the known source strings (`"local"`, `"http"`, `"mcp"`). This is a closed set that we control.

```ts
const RESPONSE_SOURCES = ["local", "http", "mcp"] as const
type ResponseSource = typeof RESPONSE_SOURCES[number]

function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  if (typeof value !== "object" || value === null) return false
  const obj = value as Record<string, unknown>
  if (!("data" in obj) || !("meta" in obj)) return false
  if (typeof obj.meta !== "object" || obj.meta === null) return false
  return RESPONSE_SOURCES.includes((obj.meta as ResponseMeta).source as ResponseSource)
}
```

**Why not `Symbol`**: `Symbol.for()` is realm-specific and fails across iframe/Worker boundaries. `Symbol()` requires the symbol to be exported and imported by every consumer and adapter, creating tight coupling. The string discriminant approach works everywhere and the false-positive risk is negligible because `meta.source` must be one of our three known strings.

**Why not duck-typing alone**: A user could return `{ data: "hello", meta: { source: "local" } }` as an operation output that happens to match the envelope shape. However, since the known sources (`"local"`, `"http"`, `"mcp"`) are under our control and unlikely to appear naturally in operation outputs, the risk is acceptable. If it becomes a problem, we can add a versioned brand string like `__envelopeVersion: 1`.

**Trade-offs**:
- (+) Works across all JS realms (no Symbol cross-realm issues)
- (+) No import coupling — adapters don't need to import a symbol
- (+) JSON-serializable — envelope survives transport boundaries (pubsub over Redis/WebSocket)
- (+) `isResponseEnvelope()` type guard provides TypeScript narrowing
- (−) Theoretical false-positive if a user returns an object with `meta.source: "local"` by coincidence
- (−) New sources must be registered in `RESPONSE_SOURCES`

**Rationale**: The string discriminant approach is the simplest, most portable, and most debuggable option. It works with JSON serialization (important for cross-transport), requires no cross-realm Symbol handling, and the closed `RESPONSE_SOURCES` set prevents accidental collision. The `isResponseEnvelope()` guard provides a single point of detection logic.

---

### ADR-013: `outputSchema` Validates Inner Data, Not Envelope

**Context**: After envelope wrapping, `execute()` returns `ResponseEnvelope<TOutput>`. But `outputSchema` on `OperationSpec` describes the inner `data` shape (e.g., `Type.Object({ result: Type.String() })`), not the full envelope. If output validation is changed to validate against the envelope, it would always fail.

**Decision**: `outputSchema` validates the inner `data` of the envelope, not the full `ResponseEnvelope`. The current `registry.execute()` validation flow changes to:

1. Run handler
2. Wrap result in envelope (if not already one)
3. Validate `envelope.data` against `spec.outputSchema` (warning-only, not thrown)
4. Return envelope

This means `outputSchema` continues to describe the business data shape, not the transport envelope. The envelope is always present in the return value but is not part of the schema contract.

**Trade-offs**:
- (+) `outputSchema` stays focused on business data — no envelope schema bloat
- (+) Existing `outputSchema` definitions don't need changes
- (+) Clear separation: schema describes data, envelope describes transport
- (−) Callers must understand that `outputSchema` validates `data`, not the full envelope
- (−) The envelope shape itself is not validated by `outputSchema` (but it has its own `ResponseEnvelopeSchema`)

---

### ADR-014: No Client Abstraction (Yet)

**Context**: A "client" that handles envelopes, retries, and transport details was considered. This would be a higher-level abstraction that sits above the registry and call protocol.

**Decision**: Do not introduce a `Client` class at this time. The current architecture has three distinct layers that serve different purposes:
- `OperationRegistry` — spec/handler storage, `execute()` for direct calls
- `PendingRequestMap` / `CallHandler` — event-based call protocol
- `ResponseEnvelope` — result wrapping with metadata

A "client" would conflate these layers. Instead, the envelope concept is introduced as a result type that flows through existing mechanisms.

The `buildEnv()` function is the closest thing to a "client" — it provides namespace-keyed operation access. It should be updated to propagate envelopes.

**Trade-offs**:
- (+) Avoids over-engineering; the envelope type is sufficient for the current need
- (+) Each layer stays focused on its concern
- (−) There's no single "call this operation and give me the result" API that handles envelope unwrapping
- (−) Consumers must understand the envelope concept to get at data

**Rationale**: The registry + execute + envelope is sufficient. A client abstraction can be introduced later if a clear pattern emerges from usage.

## Types

### `ResponseEnvelope`

```ts
interface ResponseEnvelope<T = unknown> {
  data: T
  meta: ResponseMeta
}
```

The universal result wrapper. `data` holds the operation output. `meta` carries transport-specific metadata.

Note: There is no Symbol brand on `ResponseEnvelope`. Detection is via `isResponseEnvelope()` which checks `meta.source` against the known sources. See ADR-012.

### `ResponseMeta` (discriminated union)

```ts
type ResponseMeta = LocalResponseMeta | HTTPResponseMeta | MCPResponseMeta

type ResponseSource = "local" | "http" | "mcp"

interface LocalResponseMeta {
  source: "local"
  operationId: string
  timestamp: number  // Unix epoch milliseconds (Date.now())
}

interface HTTPResponseMeta {
  source: "http"
  statusCode: number
  headers: Record<string, string>  // Single-value only; multi-value headers joined with ", "
  contentType: string
}

interface MCPResponseMeta {
  source: "mcp"
  isError: boolean
  content: MCPContentBlock[]
  structuredContent?: Record<string, unknown>
  _meta?: Record<string, unknown>
}
```

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

These types mirror the MCP `CallToolResult` and `ContentBlock` structure, but are defined independently to avoid coupling to the MCP SDK as a runtime dependency. The MCP adapter maps from SDK types to these types.

### Schema Constants

```ts
const LocalResponseMetaSchema = Type.Object({
  source: Type.Literal("local"),
  operationId: Type.String(),
  timestamp: Type.Number({ description: "Unix epoch milliseconds" }),
})

const HTTPResponseMetaSchema = Type.Object({
  source: Type.Literal("http"),
  statusCode: Type.Number(),
  headers: Type.Record(Type.String(), Type.String()),
  contentType: Type.String(),
})

const MCPResponseMetaSchema = Type.Object({
  source: Type.Literal("mcp"),
  isError: Type.Boolean(),
  content: Type.Array(MCPContentBlockSchema),
  structuredContent: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  _meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
})

const ResponseMetaSchema = Type.Union([
  LocalResponseMetaSchema,
  HTTPResponseMetaSchema,
  MCPResponseMetaSchema,
])

const ResponseEnvelopeSchema = Type.Object({
  data: Type.Unknown({ description: "Operation output" }),
  meta: ResponseMetaSchema,
})
```

TypeBox schemas for use in validation, spec definitions, and call protocol events.

### `isResponseEnvelope()`

```ts
const RESPONSE_SOURCES = ["local", "http", "mcp"] as const

function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  if (typeof value !== "object" || value === null) return false
  const obj = value as Record<string, unknown>
  if (!("data" in obj) || !("meta" in obj)) return false
  if (typeof obj.meta !== "object" || obj.meta === null) return false
  return RESPONSE_SOURCES.includes(
    (obj.meta as ResponseMeta).source as ResponseSource
  )
}
```

Type guard for envelope detection. Used by `execute()` and `CallHandler` to determine whether a handler return value is already an envelope or needs wrapping.

### `unwrap()`

```ts
function unwrap<T>(envelope: ResponseEnvelope<T>): T {
  return envelope.data
}
```

### Factory Functions

Adapters should not construct envelope objects directly. Instead, they should use factory functions that ensure the correct `source` discriminant and consistent construction:

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

These factories ensure the `source` string matches exactly, are used by `isResponseEnvelope()` detection, and provide a single point of construction for future evolution. Note: `localEnvelope(undefined, opId)` is valid — `T` resolves to `undefined` for void handlers, and the envelope wraps `data: undefined`.

## Integration Points

### API Impact Summary

| API | Before | After |
|-----|--------|-------|
| `registry.execute()` return | `Promise<TOutput>` | `Promise<ResponseEnvelope<TOutput>>` |
| `callMap.call()` resolve value | `unknown` (raw) | `ResponseEnvelope` |
| `call.responded.output` | `unknown` | `ResponseEnvelopeSchema` |
| MCP handler return | `ContentBlock[]` (raw) | `ResponseEnvelope` (via `mcpEnvelope()`) |
| HTTP handler return | `any` (JSON/text/ArrayBuffer) | `ResponseEnvelope` (via `httpEnvelope()`) |
| Local handler return | raw value (unchanged) | raw value (infrastructure wraps via `localEnvelope()`) |
| `outputSchema` validation target | raw return value | `envelope.data` |
| `subscribe()` yield | raw value | `ResponseEnvelope` per yield |

### `OperationRegistry.execute()`

Currently returns `Promise<TOutput>`. After envelopes, returns `Promise<ResponseEnvelope<TOutput>>`:

```ts
async execute<TInput = unknown, TOutput = unknown>(
  operationId: string,
  input: TInput,
  context: OperationContext,
): Promise<ResponseEnvelope<TOutput>>
```

Implementation:
1. Look up spec and handler (existing behavior)
2. Validate input with `validateOrThrow` (existing behavior)
3. Run the handler
4. If the return value `isResponseEnvelope()` → pass through as the result
5. Otherwise → wrap in `localEnvelope(result, operationId)`
6. Validate `envelope.data` against `spec.outputSchema` (warning-only, not thrown)
7. Return envelope

Note: `isResponseEnvelope()` detects envelopes by `meta.source` matching a known source string. It does not validate that the envelope's `source` matches the operation's origin. For example, an MCP handler that explicitly returns a `localEnvelope(...)` would pass through as-is. Handlers that explicitly construct envelopes take responsibility for their metadata.

### `CallHandler`

The `CallHandler` currently calls `handler(input, context)` and expects the handler to publish `call.responded` itself. After envelopes, `CallHandler` takes full ownership of publishing:

1. Look up spec and handler (existing behavior)
2. Check access control (existing behavior)
3. Validate input (existing behavior)
4. Call `handler(input, context)` and await the result
5. If the result `isResponseEnvelope()` → use it directly
6. Otherwise → wrap in `localEnvelope(result, operationId)`
7. Validate `envelope.data` against `spec.outputSchema` — warning-only, logged but not thrown (consistent with `execute()`)
8. Publish `call.responded` via `callMap.respond(requestId, envelope)`
9. On handler exception → publish `call.error` (existing behavior). Note: an envelope with `meta.isError: true` (e.g., MCP error results) does **not** trigger `call.error`. Only thrown exceptions from the handler trigger `call.error`. An envelope with `meta.isError: true` is a successful return where the consumer checks `envelope.meta.isError`.

This eliminates the current pattern where handlers must publish `call.responded` themselves. Handlers never call `callMap.respond()` — they return values.

**`PendingRequestMap.respond()` enforcement**: Since `CallHandler` is the sole publisher, `respond(requestId, output)` must enforce that `output` is a valid `ResponseEnvelope`. If `respond()` is called with a non-envelope value, it throws an error. This prevents any code bypassing `CallHandler` from publishing raw values to the call protocol. A future iteration may make `respond()` internal (not exported on the public API surface) to further enforce this invariant.

### `PendingRequestMap.call()`

Currently resolves with `responded.output` (typed as `unknown`). After envelopes, resolves with the `ResponseEnvelope`:

```ts
// Before
pending.resolve(responded.output)

// After
pending.resolve(responded.output as ResponseEnvelope)
```

### `buildEnv()`

Currently returns `OperationEnv = Record<string, Record<string, (input: unknown) => Promise<unknown>>>`. After envelopes, each function returns `Promise<ResponseEnvelope>`. The type becomes:

```ts
type OperationEnv = Record<string, Record<string, (input: unknown) => Promise<ResponseEnvelope>>>
```

Nested operation calls always get envelopes, which is consistent with `execute()`.

### `subscribe()`

Currently yields raw handler output. After envelopes:

```ts
async function* subscribe(
  registry: OperationRegistry,
  operationId: string,
  input: unknown,
  context: OperationContext,
): AsyncGenerator<ResponseEnvelope, void, unknown>
```

Wrapping flow:
1. Get spec and handler from registry (existing behavior)
2. Cast handler to `AsyncGenerator` and iterate
3. For each yielded value: if `isResponseEnvelope(value)` → yield it directly; otherwise → wrap in `localEnvelope(value, operationId)` and yield
4. `operationId` comes from the `subscribe()` parameter; `timestamp` is `Date.now()` per yield (fresh timestamp for each emitted event)
5. On generator cleanup, call `generator.return()` in `finally` (existing behavior)

Adapter subscription handlers (e.g., SSE in OpenAPI) that explicitly return `ResponseEnvelope` values pass through via `isResponseEnvelope()` detection. The same `ResponseEnvelope` type is used for consistency — there is no separate `SubscriptionEnvelope`.

### MCP Adapter (`from_mcp.ts`)

Current handler:
```ts
handler: async (input) => {
  const result = await client.callTool({ name, arguments: input })
  if (result.isError) throw new Error(`MCP tool error: ${JSON.stringify(result.content)}`)
  return result.content  // returns ContentBlock[]
}
```

After envelopes:
```ts
handler: async (input) => {
  const result = await client.callTool({ name, arguments: input })
  if (result.isError) {
    // MCP isError: true means the tool ran but returned an error result.
    // We still wrap it in an envelope — the consumer checks meta.isError.
    // Transport-level errors (tool not found, connection failure) still throw CallError.
  }
  return mcpEnvelope(
    result.structuredContent ?? mapMCPContentBlocks(result.content),
    {
      isError: result.isError ?? false,
      content: mapMCPContentBlocks(result.content),
      structuredContent: result.structuredContent,
      _meta: result._meta as Record<string, unknown> | undefined,
    },
  )
}
```

**Key behavior change**: MCP `isError: true` no longer throws. The error content is accessible via `envelope.data` and `envelope.meta.content`. The consumer checks `envelope.meta.isError` to distinguish error results from success results. This preserves the MCP semantic where error content is still useful.

**`mapMCPContentBlocks()`**: Maps SDK `ContentBlock[]` to our `MCPContentBlock[]`. Signature: `(sdkBlocks: SDKContentBlock[]) => MCPContentBlock[]`. This is a 1:1 field mapping from MCP SDK types to our own `MCPContentBlock` discriminated union, decoupling us from the MCP SDK at the interface level. Each SDK content block type (`text`, `image`, `audio`, `resource`, `resource_link`) maps to the corresponding variant in our `MCPContentBlock` type, preserving all fields including optional `annotations`.

### OpenAPI Adapter (`from_openapi.ts`)

Current handler returns raw `response.json()` / `.text()` / `.arrayBuffer()`.

After envelopes:
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

### Call Protocol Event Shape

`call.responded` changes from `{ requestId, output: unknown }` to `{ requestId, output: ResponseEnvelope }`.

`CallRespondedEventSchema`:
```ts
"call.responded": Type.Object({
  requestId: Type.String(),
  output: ResponseEnvelopeSchema,
})
```

## Constraints

1. **No runtime envelope overhead for local handlers** — local handlers return raw values; wrapping happens in infrastructure, not in user code
2. **Envelope is always present at the call protocol boundary** — `call.responded` always carries `ResponseEnvelope`, never raw values. `PendingRequestMap.respond()` enforces this at runtime.
3. **Adapters use factory functions** — `localEnvelope()`, `httpEnvelope()`, `mcpEnvelope()` ensure correct `source` discriminant and consistent construction. Adapters do not construct envelope objects directly.
4. **MCPContentBlock types are our own, not MCP SDK types** — avoids runtime dependency on `@modelcontextprotocol/sdk` in the main barrel
5. **Breaking change: single-release, no transitional API** — `execute()` return type and `call.responded.output` shape change in one release. Call protocol is draft status, package is pre-1.0, consumers are coordinated.
6. **`unwrap()` is the recommended simple-path API** — for consumers that don't need metadata
7. **`outputSchema` validates `envelope.data`, not the full envelope** — `ResponseEnvelopeSchema` validates the envelope structure at the call protocol level; `outputSchema` validates the business data
8. **`isResponseEnvelope()` is the sole detection mechanism** — no Symbol brands, no duck-typing beyond the closed `source` discriminant set

## Related Spec Updates

When this spec stabilizes, the following documents must be updated to reflect envelope changes:

| Document | Section | Change |
|----------|----------|--------|
| `call-protocol.md` | CallHandler | Handler no longer publishes `call.responded`; returns values. CallHandler wraps and publishes. |
| `call-protocol.md` | PendingRequestMap | `respond()` validates envelope; resolves with `ResponseEnvelope` instead of `unknown` |
| `call-protocol.md` | CallEventMap | `call.responded.output` changes from `Type.Unknown()` to `ResponseEnvelopeSchema` |
| `api-surface.md` | execute() | Return type: `Promise<TOutput>` → `Promise<ResponseEnvelope<TOutput>>` |
| `api-surface.md` | PendingRequestMap | `call()` resolve type: `unknown` → `ResponseEnvelope` |
| `api-surface.md` | subscribe() | Yield type: `unknown` → `ResponseEnvelope` |
| `api-surface.md` | OperationEnv | Inner function return type: `Promise<unknown>` → `Promise<ResponseEnvelope>` |
| `api-surface.md` | CallHandler | New: wraps handler result, publishes `call.responded`. No longer "handler publishes" model. |
| `adapters.md` | from_mcp | Handler returns `mcpEnvelope()`. MCP `isError: true` no longer throws. |
| `adapters.md` | from_openapi | Handler returns `httpEnvelope()`. Error on HTTP error status still throws `CallError`. |

Additionally, any code subscribing to `"call.responded"` events via the pubsub system (not just `PendingRequestMap`, but any direct pubsub consumer) must expect `ResponseEnvelope` instead of `unknown` in the event payload.

## References

- MCP `CallToolResult` — `spec.types.d.ts` in `@modelcontextprotocol/sdk`
- MCP `ContentBlock` type — discriminated union of `text`, `image`, `audio`, `resource`, `resource_link`
- OpenAPI response handling — `src/from_openapi.ts`, `createHTTPOperation` handler
- Call protocol events — `src/call.ts`, `CallEventSchema`
- [call-protocol.md](call-protocol.md) — Current event shapes and `PendingRequestMap` design
- [adapters.md](adapters.md) — Current adapter handler implementations