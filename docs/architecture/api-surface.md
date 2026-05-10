---
status: draft
last_updated: 2026-05-10
---

# API Surface

All public types, registry, call protocol, subscribe, env, validation, adapters, and response envelopes. See [call-protocol.md](call-protocol.md) for detailed call protocol semantics, [response-envelopes.md](response-envelopes.md) for the envelope type system and integration points, and [adapters.md](adapters.md) for adapter internals.

## Core Types

### `OperationType`

```ts
enum OperationType {
  QUERY = "query",
  MUTATION = "mutation",
  SUBSCRIPTION = "subscription",
}
```

- `QUERY` — read-only, no side effects
- `MUTATION` — write, has side effects
- `SUBSCRIPTION` — async generator, yields multiple values over time

### `Identity`

```ts
interface Identity {
  id: string
  scopes: string[]
  resources?: Record<string, string[]>
}
```

Caller security context. `scopes` are global permissions (AND-checked against `requiredScopes`). `resources` maps `"type:id"` to action arrays (checked against `resourceType`/`resourceAction`). Derived from keypal `ApiKeyMetadata`.

### `AccessControl`

```ts
type AccessControl = Static<typeof AccessControlSchema>

const AccessControlSchema = Type.Object({
  requiredScopes: Type.Array(Type.String()),
  requiredScopesAny: Type.Optional(Type.Array(Type.String())),
  resourceType: Type.Optional(Type.String()),
  resourceAction: Type.Optional(Type.String()),
  customAuth: Type.Optional(Type.String()),
})
```

| Field | Semantics |
|-------|-----------|
| `requiredScopes` | AND — caller must have ALL listed scopes |
| `requiredScopesAny` | OR — caller must have at least ONE listed scope |
| `resourceType` | Resource category for resource-scoped checks |
| `resourceAction` | Required action on the resource |
| `customAuth` | Name of custom auth function (not yet enforced) |

### `ErrorDefinition`

```ts
type ErrorDefinition = Static<typeof ErrorDefinitionSchema>

const ErrorDefinitionSchema = Type.Object({
  code: Type.String(),
  description: Type.String(),
  schema: Type.Unknown(),
  httpStatus: Type.Optional(Type.Number()),
})
```

Declared on `IOperationDefinition.errorSchemas`. Contract between operation and callers about what errors it may produce.

### Response Envelope Types

All operation results are wrapped in `ResponseEnvelope` at the call protocol boundary. See [response-envelopes.md](response-envelopes.md) for the full type system, factory functions, and integration points.

```ts
interface ResponseEnvelope<T = unknown> {
  data: T
  meta: ResponseMeta
}

type ResponseMeta = LocalResponseMeta | HTTPResponseMeta | MCPResponseMeta
type ResponseSource = "local" | "http" | "mcp"

interface LocalResponseMeta {
  source: "local"
  operationId: string
  timestamp: number
}

interface HTTPResponseMeta {
  source: "http"
  statusCode: number
  headers: Record<string, string>
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

### `OperationContext`

```ts
type OperationContext = Static<typeof OperationContextSchema> & {
  env?: OperationEnv
  stream?: () => AsyncIterable<unknown>
  pubsub?: unknown
}
```

Passed to every handler. `env` provides namespace-keyed access to other operations (via `buildEnv`). `stream` and `pubsub` support subscription and event patterns.

### `OperationSpec`

```ts
interface OperationSpec<TInput = unknown, TOutput = unknown> {
  name: string
  namespace: string
  version: string
  type: OperationType
  title?: string
  description: string
  tags?: string[]
  inputSchema: TSchema
  outputSchema: TSchema
  errorSchemas?: ErrorDefinition[]
  accessControl: AccessControl
  _meta?: Record<string, unknown>
}
```

Serializable, hashable descriptor. No handler — safe to send over the wire, persist, or use as a template for ujsx tree interpretation. `Value.Hash(inputSchema)` provides structural deduplication keys.

### `IOperationDefinition`

```ts
interface IOperationDefinition<TInput, TOutput, TContext> extends OperationSpec<TInput, TOutput> {
  handler: OperationHandler<TInput, TOutput, TContext> | SubscriptionHandler<TInput, TOutput, TContext>
}
```

Convenience type combining spec and handler. Still supported by `register()` for backward compatibility, but the registry now stores them separately internally.

### `OperationHandler` / `SubscriptionHandler`

```ts
type OperationHandler<TInput, TOutput, TContext> = (
  input: TInput, context: TContext,
) => Promise<TOutput> | TOutput

type SubscriptionHandler<TInput, TOutput, TContext> = (
  input: TInput, context: TContext,
) => AsyncGenerator<TOutput, void, unknown>
```

`OperationHandler` returns a single value. `SubscriptionHandler` yields values over time. Both return/yield **raw values** — wrapping in `ResponseEnvelope` happens in infrastructure (`execute()`, `CallHandler`, `subscribe()`). Handlers that need to provide transport metadata can return a pre-built `ResponseEnvelope` (detected by `isResponseEnvelope()`), but this is only needed for adapter handlers (MCP, OpenAPI).

### `OperationEnv`

```ts
type OperationEnv = Record<string, Record<string, (input: unknown) => Promise<ResponseEnvelope>>>
```

Namespace-keyed operation map. Accessed as `env.namespace.operationName(input)`. Created by `buildEnv`. Each inner function returns `Promise<ResponseEnvelope>` — callers access typed data via `envelope.data` and metadata via `envelope.meta`, or use `unwrap(envelope)` for the common case where only `data` is needed.

**Type note**: `OperationEnv` inner functions return `Promise<ResponseEnvelope>` (untyped), which means callers lose per-operation type inference through `OperationEnv`. The generic `TOutput` of the underlying operation is not propagated through the namespace-keyed map — this is an inherent limitation of the string-keyed access pattern. Consumers should use `envelope.data` with their own type narrowing, or use `registry.execute()` directly when type inference is needed.

## Registry

### `OperationRegistry`

The registry stores specs and handlers in separate internal maps. Specs are serializable descriptors; handlers are runtime functions. They can be registered together or separately.

| Method | Signature | Description |
|--------|-----------|-------------|
| `register(operation)` | `(operation: OperationSpec & { handler?: OperationHandler \| SubscriptionHandler }) => void` | Register spec + optional handler by `{namespace}.{name}` key. Validates schemas. |
| `registerAll(operations)` | `(operations: Array<OperationSpec & { handler?: ... }>) => void` | Bulk register. |
| `registerSpec(spec)` | `(spec: OperationSpec) => void` | Register spec only (no handler). Validates schemas. |
| `registerHandler(id, handler)` | `(id: string, handler: OperationHandler \| SubscriptionHandler) => void` | Register handler for existing spec. Throws if spec not found. |
| `get(id)` | `(id: string) => (OperationSpec & { handler?: ... }) \| undefined` | Get spec + handler (if registered) by full id. |
| `getSpec(id)` | `(id: string) => OperationSpec \| undefined` | Serializable spec (no handler). |
| `getHandler(id)` | `(id: string) => OperationHandler \| SubscriptionHandler \| undefined` | Handler only. `undefined` if spec registered without handler. |
| `getByName(namespace, name)` | `(namespace: string, name: string) => (OperationSpec & { handler?: ... }) \| undefined` | Get by parts. |
| `list()` | `() => Array<OperationSpec & { handler?: ... }>` | All registered entries (spec + handler if present). |
| `getAllSpecs()` | `() => OperationSpec[]` | All serializable specs. |
| `execute(operationId, input, context)` | `(id: string, input: TInput, ctx: OperationContext) => Promise<ResponseEnvelope<TOutput>>` | Validate input, run handler, wrap result in `ResponseEnvelope`, warn on output mismatch. Throws if spec or handler not found. |

Registration key format: `{namespace}.{name}`. Overwrite on duplicate.

Specs and handlers can be registered independently: `registerSpec()` then `registerHandler()` for the same id, or `register()` with `{ ...spec, handler }` in one call. `execute()` requires both — throws `"Operation not found"` if spec missing, `"No handler registered"` if handler missing.

`execute` validates input with `validateOrThrow` before calling the handler. The handler return value is wrapped in a `ResponseEnvelope` via `isResponseEnvelope()` detection — if the result is already an envelope, it passes through; otherwise `localEnvelope(result, operationId)` wraps it. Output validation uses `collectErrors` on `envelope.data` against `spec.outputSchema` and logs warnings — it does not throw.

## Call Protocol

### `PendingRequestMap`

See [call-protocol.md](call-protocol.md) for full semantics.

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor(eventTarget?)` | `(eventTarget?: EventTarget)` | Creates internal pubsub, wires subscription handlers for responded/error/aborted. |
| `call(operationId, input, options?)` | `Promise<ResponseEnvelope>` | Publish `call.requested`, return Promise that resolves with `ResponseEnvelope` on `call.responded`. |
| `respond(requestId, output)` | `void` | Publish `call.responded`. `output` must be `ResponseEnvelope` — `isResponseEnvelope()` guard throws on raw values. |
| `emitError(requestId, code, message, details?)` | `void` | Publish `call.error`. |
| `abort(requestId)` | `void` | Publish `call.aborted`, reject pending Promise. |
| `getPendingCount()` | `number` | Number of in-flight requests. |

### `CallHandler`

```ts
type CallHandler = (event: CallRequestedEvent) => Promise<void>
```

Created by `buildCallHandler({ registry, eventTarget? })`. Subscribes to `call.requested`, checks access control, validates input, calls the handler directly (not via `registry.execute()`), applies the shared result pipeline (detect → wrap → normalize → validate), and publishes `call.responded`. On failure: publishes `call.error` with mapped `CallError`. Adapters that return pre-built envelopes (MCP, OpenAPI) pass through via `isResponseEnvelope()` detection. See [response-envelopes.md](response-envelopes.md#shared-result-pipeline) for the shared pipeline definition.

### `CallEventMap`

```ts
const CallEventMap = {
  "call.requested": Type.Object({ ... }),
  "call.responded": Type.Object({ ... }),
  "call.aborted": Type.Object({ ... }),
  "call.error": Type.Object({ ... }),
}
```

Typed event map compatible with `@alkdev/pubsub`. See [call-protocol.md](call-protocol.md) for event shapes.

### Event Types

| Type | Fields | Description |
|------|--------|-------------|
| `CallRequestedEvent` | `requestId, operationId, input, parentRequestId?, deadline?, identity?` | Initiates a call |
| `CallRespondedEvent` | `requestId, output: ResponseEnvelope` | Successful response (envelope always present) |
| `CallAbortedEvent` | `requestId` | Call cancelled |
| `CallErrorEvent` | `requestId, code, message, details?` | Error response |

## Subscribe

### `subscribe`

```ts
async function* subscribe(
  registry: OperationRegistry,
  operationId: string,
  input: unknown,
  context: OperationContext,
): AsyncGenerator<ResponseEnvelope, void, unknown>
```

Direct subscription execution. Gets the operation, casts its handler to `AsyncGenerator`, yields each value wrapped in `ResponseEnvelope`. If a yielded value is already an envelope (`isResponseEnvelope()`), it passes through. Otherwise, `localEnvelope(value, operationId)` wraps it. Properly cleans up the generator on iteration stop (calls `generator.return()` in `finally`).

This is the synchronous alternative to the call protocol's `call.requested` → `call.responded` flow for subscriptions. Use `subscribe()` for in-process subscription consumption; use `PendingRequestMap` for cross-transport subscription.

## Env Builder

### `buildEnv`

```ts
function buildEnv(options: EnvOptions): OperationEnv

interface EnvOptions {
  registry: OperationRegistry
  context: OperationContext
  allowedNamespaces?: string[]
  callMap?: PendingRequestMap
}
```

Creates a namespace-keyed `OperationEnv` for nested operation calls. Each env function returns `Promise<ResponseEnvelope>` — callers access typed data via `envelope.data` or use `unwrap(envelope)`. Two modes:

- **Direct mode**: `buildEnv({ registry, context })` — env functions call `registry.execute()`, which wraps in `localEnvelope`
- **Call protocol mode**: `buildEnv({ registry, context, callMap })` — env functions call `callMap.call()`, which resolves to `ResponseEnvelope` directly, publishing `call.requested` events with `parentRequestId` for call graph tracking

`SUBSCRIPTION` operations are filtered out — env only provides QUERY and MUTATION operations for nested calls.

`allowedNamespaces` restricts which namespaces are available.

## Validation

| Export | Signature | Description |
|--------|-----------|-------------|
| `assertIsSchema(schema, context?)` | `(unknown, string?) => void` | Throws if `schema` is not a valid TypeBox schema. |
| `validateOrThrow(schema, value, context?)` | `(TSchema, unknown, string?) => void` | Throws with formatted errors if value fails schema check. |
| `collectErrors(schema, value)` | `(TSchema, unknown) => Array<{path, message}>` | Returns errors array (empty if valid). |
| `formatValueErrors(errors, indent?)` | `(Iterable<{path, message}>, string?) => string` | Human-readable error formatting. |

## Error Model

### `CallError`

```ts
class CallError extends Error {
  readonly code: CallErrorCode
  readonly details?: unknown
  constructor(code: CallErrorCode, message: string, details?: unknown)
}
```

### `InfrastructureErrorCode`

```ts
enum InfrastructureErrorCode {
  OPERATION_NOT_FOUND = "OPERATION_NOT_FOUND",
  ACCESS_DENIED = "ACCESS_DENIED",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  TIMEOUT = "TIMEOUT",
  ABORTED = "ABORTED",
  EXECUTION_ERROR = "EXECUTION_ERROR",
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}
```

`CallErrorCode` is `InfrastructureErrorCode | string` — domain codes from `errorSchemas` are plain strings.

### `mapError`

```ts
function mapError(error: unknown, errorSchemas?: { code: string; schema: unknown }[]): CallError
```

Converts any thrown value to `CallError`. If the thrown value is already a `CallError`, returns it. If it's an `Error` and `errorSchemas` are provided, matches against declared error codes. Falls back to `EXECUTION_ERROR` for unmatched `Error` instances and `UNKNOWN_ERROR` for non-Error values.

## Schema Conversion

### `FromSchema`

```ts
function FromSchema<T>(T: T): TSchema
```

Converts JSON Schema to TypeBox `TSchema`. Handles: `allOf`, `anyOf`, `oneOf`, `enum`, `object` (with `required` tracking), `tuple`, `array`, `const`, `$ref`, primitives (`string`, `number`, `integer`, `boolean`, `null`). Unknown shapes fall back to `Type.Unknown()`.

Used internally by `FromOpenAPI` to convert OpenAPI JSON Schema definitions to TypeBox. Also used by `from_mcp` to convert MCP tool `inputSchema` (which is JSON Schema).

## Response Envelope Utilities

See [response-envelopes.md](response-envelopes.md) for detailed semantics and integration points.

| Export | Signature | Description |
|--------|-----------|-------------|
| `isResponseEnvelope(value)` | `(unknown) => value is ResponseEnvelope` | Type guard. Checks `meta.source` discriminant against `"local" \| "http" \| "mcp"`. |
| `localEnvelope(data, operationId)` | `<T>(data: T, operationId: string) => ResponseEnvelope<T>` | Wrap local handler result. |
| `httpEnvelope(data, meta)` | `<T>(data: T, meta: Omit<HTTPResponseMeta, "source">) => ResponseEnvelope<T>` | Wrap HTTP response data. |
| `mcpEnvelope(data, meta)` | `<T>(data: T, meta: Omit<MCPResponseMeta, "source">) => ResponseEnvelope<T>` | Wrap MCP tool result. |
| `unwrap(envelope)` | `<T>(envelope: ResponseEnvelope<T>) => T` | Convenience: returns `envelope.data`. |
| `ResponseEnvelopeSchema` | `TSchema` | TypeBox schema for `ResponseEnvelope`. |
| `ResponseMetaSchema` | `TSchema` | TypeBox schema for the `ResponseMeta` discriminated union. |

## Adapters

See [adapters.md](adapters.md) for detailed adapter documentation.

| Adapter | Import | Description |
|---------|--------|-------------|
| `FromOpenAPI` | Main barrel | OpenAPI spec → `OperationSpec & { handler }[]` |
| `FromOpenAPIFile` | Main barrel | OpenAPI file → `OperationSpec & { handler }[]` |
| `FromOpenAPIUrl` | Main barrel | OpenAPI URL → `OperationSpec & { handler }[]` |
| `createMCPClient` | `from-mcp` sub-path | MCP server → `MCPClientWrapper` with tool operations |
| `closeMCPClient` | `from-mcp` sub-path | Close MCP client connection |
| `MCPClientLoader` | `from-mcp` sub-path | Manage multiple MCP servers |
| `scanOperations` | Main barrel | Filesystem auto-discovery of operation specs |

## Source vs. Spec Drift

This section documents differences between the architecture spec (this document) and the current source code. Items marked **ADR-005** or **ADR-006** are planned changes not yet implemented.

### ADR-005 (Response Envelopes) — not yet implemented

| What | Spec says | Source currently does |
|------|----------|----------------------|
| `ResponseEnvelope`, `ResponseMeta`, factory functions, `isResponseEnvelope()`, `unwrap()` | Exported from `src/response-envelope.ts` | None of these types or functions exist in source |
| `execute()` return type | `Promise<ResponseEnvelope<TOutput>>` | `Promise<TOutput>` |
| `execute()` result pipeline | Detect → wrap → normalize → validate | Returns raw `result`, validates raw output with `collectErrors` |
| `OperationEnv` inner function return type | `Promise<ResponseEnvelope>` | `Promise<unknown>` |
| `PendingRequestMap.call()` return type | `Promise<ResponseEnvelope>` | `Promise<unknown>` |
| `PendingRequestMap.respond()` validation | Enforces `isResponseEnvelope()`, throws on raw values | Accepts `unknown`, no validation |
| `subscribe()` yield type | `AsyncGenerator<ResponseEnvelope, void, unknown>` | `AsyncGenerator<unknown, void, unknown>` |
| `CallRespondedEvent.output` | `ResponseEnvelope` | `unknown` |
| `CallHandler` description | Wraps handler result, applies pipeline, publishes `call.responded` | Discards handler return value; handler publishes `call.responded` itself |
| `from_mcp` handler | Returns `mcpEnvelope()`, uses `structuredContent`, extracts `outputSchema` | Returns `result.content`, types `outputSchema` as `Type.Unknown()`, throws on `isError` |
| `from_openapi` handler | Returns `httpEnvelope()` with HTTP metadata | Returns raw response data, throws on HTTP error status |

### ADR-006 (Unified Invocation Path) — not yet implemented

| What | Spec says | Source currently does |
|------|----------|----------------------|
| `execute()` access control | Checks `accessControl` when `identity` present | Skips access control entirely |
| `execute()` on unauthenticated access | Rejects with `ACCESS_DENIED` when `requiredScopes` non-empty and no `identity` | Always allows |
| `execute()` error type | Throws `CallError` | Throws plain `Error` |
| `buildEnv()` | Always uses `execute()`, no `callMap` option | Toggles between `execute()` and `callMap.call()` |
| `CallHandler` | Thin adapter calling `registry.execute()` | Reimplements lookup, validation, and access control |
| `OperationContext.trusted` | New field for nested call auth bypass | Does not exist |