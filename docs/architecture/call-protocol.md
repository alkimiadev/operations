---
status: draft
last_updated: 2026-05-10
---

# Call Protocol

PendingRequestMap, CallHandler, call≡subscribe semantics, event types, error model, and access control.

## Overview

The call protocol is the unified transport layer for all operation invocations. It provides a single event-based mechanism that works the same whether the call is local (in-process), remote (hub↔spoke over websocket), or streamed (subscription). It is built on `@alkdev/pubsub`.

At the protocol level, `call` and `subscribe` are the same thing with different consumption patterns:

- **`call`**: Publish `call.requested`, subscribe to `call.responded:{requestId}`, resolve on first response → `Promise<ResponseEnvelope>`
- **`subscribe`**: Publish `call.requested`, subscribe to `call.responded:{requestId}`, yield each response → `AsyncIterable<ResponseEnvelope>`

Both use the same event types, the same `requestId` correlation, and the same `PendingRequestMap`. `call` is semantically `subscribe().next()`. All responses are wrapped in `ResponseEnvelope` — see [response-envelopes.md](response-envelopes.md) for the full envelope type system.

## Event Types

All communication flows through typed events. The event map is defined as `CallEventMap` using TypeBox schemas, compatible with `@alkdev/pubsub`'s `PubSubPublishArgsByKey`.

### `CallEventMap`

```ts
const CallEventMap = {
  "call.requested": Type.Object({
    requestId: Type.String(),
    operationId: Type.String(),
    input: Type.Unknown(),
    parentRequestId: Type.Optional(Type.String()),
    deadline: Type.Optional(Type.Number()),
    identity: Type.Optional(Type.Object({
      id: Type.String(),
      scopes: Type.Array(Type.String()),
      resources: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
    })),
  }),
  "call.responded": Type.Object({
    requestId: Type.String(),
    output: ResponseEnvelopeSchema,
  }),
  "call.aborted": Type.Object({
    requestId: Type.String(),
  }),
  "call.error": Type.Object({
    requestId: Type.String(),
    code: Type.String(),
    message: Type.String(),
    details: Type.Optional(Type.Unknown()),
  }),
}
```

`call.responded.output` uses `ResponseEnvelopeSchema` (defined in [response-envelopes.md](response-envelopes.md)). This means every response through the call protocol carries `data` and `meta` with source-discriminated metadata. Handlers do not construct this envelope manually — `CallHandler` wraps handler return values automatically.

### Request Correlation

Every call has a unique `requestId` (UUID). Nested calls include `parentRequestId` to track the call chain. Responses and errors match to requests by `requestId`.

### Event Flow

```
Caller                              Handler
  │                                    │
  │─── call.requested ───────────────>│
  │     {requestId, operationId,       │
  │      input, identity, deadline}   │
  │                                    │  handler returns value
  │                                    │  CallHandler wraps in ResponseEnvelope
  │<── call.responded ────────────────│
  │     {requestId,                   │
  │      output: ResponseEnvelope}    │
```

On error:

```
  │<── call.error ────────────────────│
  │     {requestId, code, message,    │
  │      details}                     │
```

On abort (caller cancels):

```
  │─── call.aborted ─────────────────>│
  │     {requestId}                   │
```

### Identity

The `identity` field in `call.requested` carries the caller's security context through the call chain. Derived from keypal's `ApiKeyMetadata` — `scopes` maps directly, `resources` uses key format `"type:id"` with scope arrays. Checked by `CallHandler` against the operation's `AccessControl`.

## PendingRequestMap

`PendingRequestMap` manages in-flight requests and provides the `call()` interface. It wraps `@alkdev/pubsub` internally.

### Construction

```ts
const callMap = new PendingRequestMap(eventTarget?)
```

- Creates an internal `PubSub<CallPubSubMap>` using `createPubSub`
- If `eventTarget` is provided, passes it to `createPubSub` for transport-level event routing (Redis, WebSocket, etc.)
- Wires subscription handlers for `call.responded`, `call.error`, and `call.aborted` to route events back to waiting callers
- Subscriptions use empty-string id (`subscribe("call.responded", "")`) to receive all events of each type. Events are unwrapped from `EventEnvelope` via `.payload`

### `call(operationId, input, options?)`

```ts
async call(
  operationId: string,
  input: unknown,
  options?: { parentRequestId?: string; deadline?: number; identity?: Identity },
): Promise<ResponseEnvelope>
```

1. Generate `requestId` via `crypto.randomUUID()`
2. Create a `PendingRequest` with `resolve`/`reject` from a new Promise
3. If `deadline` is set, start a timeout timer that rejects with `TIMEOUT`
4. Store `PendingRequest` in the internal map
5. Publish `call.requested` event with all fields
6. Return the Promise (resolves with `ResponseEnvelope` on `call.responded`, rejects on `call.error` or `call.aborted`)

The resolved value is a `ResponseEnvelope` — consumers access typed data via `envelope.data` and source metadata via `envelope.meta`. Use `unwrap(envelope)` as a convenience for the common case where only `data` is needed.

### Internal Subscription Wiring

On construction, three async loops subscribe to pubsub topics:

- **`call.responded`**: Look up `PendingRequest` by `requestId`, clear timer if set, resolve with the `ResponseEnvelope` from `output` field. The envelope is already validated by `respond()`'s `isResponseEnvelope()` guard (or created by `CallHandler`'s wrapping logic), so no additional validation is needed at this point.
- **`call.error`**: Look up `PendingRequest`, clear timer, reject with `CallError(code, message, details)`
- **`call.aborted`**: Look up `PendingRequest`, clear timer, reject with `CallError(ABORTED, ...)`

### `respond(requestId, output)`

Publishes `call.responded`. The `output` parameter must be a `ResponseEnvelope` — `isResponseEnvelope()` is checked and a non-envelope value throws. This enforces the invariant that all call protocol responses carry source metadata.

In practice, `respond()` is called by `CallHandler` after wrapping the handler's return value. Direct calls to `respond()` with raw values are rejected.

### `emitError(requestId, code, message, details?)`

Publishes `call.error`. Used by handlers to send errors.

### `abort(requestId)`

Looks up the `PendingRequest`, clears its timer, publishes `call.aborted`, rejects the Promise with `CallError(ABORTED, ...)`.

## CallHandler

`buildCallHandler` creates a function that bridges pubsub events to `OperationRegistry.execute()`. It takes full ownership of publishing `call.responded` — handlers return values; they do NOT publish events.

```ts
function buildCallHandler(config: CallHandlerConfig): CallHandler

interface CallHandlerConfig {
  registry: OperationRegistry
  eventTarget?: EventTarget
}

type CallHandler = (event: CallRequestedEvent) => Promise<void>
```

### Handler Flow

1. Look up spec by `operationId` from the registry via `getSpec()`
2. If not found, throw `CallError(OPERATION_NOT_FOUND, ...)`
3. Look up handler by `operationId` via `getHandler()`
4. If not found, throw `CallError(OPERATION_NOT_FOUND, "No handler registered for operation: ...")`
5. Check access control (see below)
6. Validate input with `validateOrThrow`
7. Execute operation handler
8. On success: apply the shared result pipeline (see [Response Envelopes → Shared Result Pipeline](response-envelopes.md#shared-result-pipeline)):
   - Detect: `isResponseEnvelope(result)` → pass through, otherwise `localEnvelope(result, operationId)`
   - Normalize: `Value.Cast(spec.outputSchema, envelope.data)` when `outputSchema` is not `Type.Unknown()`
   - Validate: `collectErrors(spec.outputSchema, envelope.data)` — warning-only
   - Publish `call.responded` via `callMap.respond(requestId, envelope)`
9. On failure: `mapError` converts the thrown value to `CallError`, publish `call.error`

**Key change**: In the pre-envelope model, handlers were responsible for publishing `call.responded` themselves (the handler return value was discarded). In the envelope model, `CallHandler` owns wrapping and publishing. Handler return values are captured and wrapped. This ensures every response goes through the envelope pipeline — no raw values can bypass it.

### MCP and OpenAPI Handlers

Adapter handlers (from `from_mcp` and `from_openapi`) return pre-built `ResponseEnvelope` instances via `mcpEnvelope()` and `httpEnvelope()` factory functions. When `CallHandler` detects `isResponseEnvelope()` on the result, it passes through without re-wrapping. This means adapter metadata (HTTP status codes, MCP `isError` flags) is preserved.

For MCP results with `meta.isError: true`, the handler still returns an envelope — the error is represented as data, not thrown. Only thrown exceptions trigger `call.error`.

## Access Control

### Enforcement Point

`CallHandler` enforces `AccessControl` before calling the handler directly. Direct `registry.execute()` calls bypass access control — this is by design for trusted internal calls.

### Flow

```
call.requested event arrives with Identity
  → Look up operation's AccessControl
  → Check requiredScopes (caller has ALL?)
  → Check requiredScopesAny (caller has ANY?)
  → Check resourceType/resourceAction against identity.resources
  → All pass → proceed to execute
  → Any fail → throw CallError(ACCESS_DENIED, ...)
```

### `checkAccess` Implementation

```ts
function checkAccess(accessControl: AccessControl, identity: Identity): boolean
```

1. If `requiredScopes` is non-empty, verify `identity.scopes` contains every entry (AND)
2. If `requiredScopesAny` is non-empty, verify `identity.scopes` contains at least one entry (OR)
3. If `resourceType` and `resourceAction` are set, verify `identity.resources["{resourceType}:{resourceId}"]` includes `resourceAction`
4. Return `true` if all applicable checks pass

Note: Access control without an `identity` in the `CallRequestedEvent` is **allowed** — unauthenticated calls are permitted if the `AccessControl` check passes (e.g., operations with empty `requiredScopes`).

## Error Model

The call protocol uses a unified error model. Both infrastructure and domain errors flow through `CallError`.

### `CallError`

```ts
class CallError extends Error {
  readonly code: CallErrorCode    // InfrastructureErrorCode | string
  readonly details?: unknown
}
```

### Infrastructure Error Codes

Reserved codes produced by `CallHandler` and `PendingRequestMap`:

| Code | When | Details |
|------|------|---------|
| `OPERATION_NOT_FOUND` | No operation matches `operationId` | `{ operationId: string }` |
| `ACCESS_DENIED` | Missing scopes | `{ requiredScopes?: string[] }` |
| `VALIDATION_ERROR` | Input fails `inputSchema` check | Wrapped from `Value.Errors` |
| `TIMEOUT` | Deadline exceeded | `{ deadline: number }` |
| `ABORTED` | Call cancelled | — |
| `EXECUTION_ERROR` | Handler threw, no `errorSchemas` match | `{ message: string }` |
| `UNKNOWN_ERROR` | Non-Error thrown | `{ raw: string }` |

### Domain Error Propagation

Operations declare their possible errors via `errorSchemas` on `IOperationDefinition`. When a handler throws, `mapError` matches the thrown error against declared schemas — falls back to `EXECUTION_ERROR` if no match.

`errorSchemas` is the contract between operation and callers about what errors it might produce. No `errorSchemas` = safe default with `EXECUTION_ERROR` wrapper.

### `mapError` Resolution

1. If already a `CallError`, return as-is
2. If `Error` instance and `errorSchemas` provided, check if `error.message` includes any declared error code → return `CallError(code, message, error)`
3. If `Error` instance, return `CallError(EXECUTION_ERROR, error.message, error)`
4. Otherwise, return `CallError(UNKNOWN_ERROR, String(error), { raw: String(error) })`

## Nested Call Wiring

Routing is an env construction concern, not a separate protocol layer. `buildEnv` creates the `OperationEnv`:

- **Direct mode**: `buildEnv({ registry, context })` — env functions call `registry.execute()` directly, returning `Promise<ResponseEnvelope>`
- **Call protocol mode**: `buildEnv({ registry, context, callMap })` — env functions call `callMap.call()`, which resolves to `Promise<ResponseEnvelope>`, publishing `call.requested` events with `parentRequestId` propagation

`parentRequestId` enables call graph reconstruction and abort cascading — every nested call includes it.

## Transport Mapping

The call protocol is transport-agnostic. The `PubSub` event target determines how events move:

| Transport | Use Case | EventTarget impl |
|-----------|----------|-----------------|
| In-process | Local hub operations | Browser `EventTarget` (default) |
| Redis | Cross-process events | `RedisEventTarget` (from `@alkdev/pubsub`) |
| WebSocket | Hub ↔ spoke bidirectional | `WebSocketEventTarget` (future) |

Same protocol, same event shapes, same `PendingRequestMap` — different `eventTarget`.

## Subscribe (Direct)

The `subscribe()` function provides direct in-process subscription consumption:

```ts
async function* subscribe(
  registry: OperationRegistry,
  operationId: string,
  input: unknown,
  context: OperationContext,
): AsyncGenerator<ResponseEnvelope, void, unknown>
```

Gets the operation from the registry, casts its handler to `AsyncGenerator`, and yields each value wrapped in `ResponseEnvelope`. If a yielded value `isResponseEnvelope()`, it passes through (e.g., for adapter handlers). Otherwise, `localEnvelope(value, operationId)` wraps it with a fresh `timestamp` per yield. Properly cleans up with `generator.return()` in a `finally` block.

Use `subscribe()` for in-process consumption. Use `PendingRequestMap.call()` for cross-transport invocation that resolves after one event. For cross-transport streaming, use `PendingRequestMap.subscribe()` to yield multiple events.

### Handler Separation

The `subscribe()` function looks up both spec and handler separately from the registry:

1. `registry.getSpec(operationId)` — throws if spec not found
2. `registry.getHandler(operationId)` — throws if handler not found

This allows spec-only registration for scenarios where handlers are provided separately (e.g., ujsx host interpretation, dynamic handler injection).

## Source vs. Spec Drift

This section documents differences between the architecture spec (this document) and the current source code. Items marked **ADR-005** or **ADR-006** are planned changes not yet implemented. Items marked **Bug** are unintentional discrepancies.

### ADR-005 (Response Envelopes) — not yet implemented

| What | Spec says | Source currently does |
|------|----------|----------------------|
| `CallEventSchema["call.responded"].output` | `ResponseEnvelopeSchema` | `Type.Unknown()` |
| `CallHandler` behavior | Wraps handler return value, publishes `call.responded` | Discards handler return value; handler must publish itself |
| `CallHandler` error handling | Publishes `call.error` via pubsub | Re-throws `CallError` (does not publish) |
| `call()` return type | `Promise<ResponseEnvelope>` | `Promise<unknown>` |
| `call()` resolution | Resolves with `ResponseEnvelope` from `output` field | Resolves with raw `unknown` from `output` |
| `respond()` validation | Enforces `isResponseEnvelope()` guard, throws on raw values | Accepts `unknown`, no validation |
| `subscribe()` yield type | `AsyncGenerator<ResponseEnvelope, void, unknown>`, wraps yields | `AsyncGenerator<unknown, void, unknown>`, yields raw values |
| `buildEnv()` return types | `Promise<ResponseEnvelope>` per function | `Promise<unknown>` per function |

### ADR-006 (Unified Invocation Path) — not yet implemented

| What | Spec says | Source currently does |
|------|----------|----------------------|
| `execute()` access control | Checks `accessControl` when `identity` present | Skips access control entirely |
| `execute()` unauthenticated calls | Rejects with `ACCESS_DENIED` when `requiredScopes` non-empty and `identity` absent | Always allows (no access check) |
| `CallHandler` calls `execute()` | Thin adapter that calls `registry.execute()` internally | Reimplements lookup, validation, and access control independently |
| `buildEnv()` | Always uses `execute()`, no `callMap` option | Toggles between `execute()` and `callMap.call()` via `if (callMap)` |
| `OperationContext.trusted` | New field for nested call bypass | Does not exist |
| `execute()` return type | `Promise<ResponseEnvelope<TOutput>>` | `Promise<TOutput>` |
| `execute()` error type | Throws `CallError` | Throws plain `Error` |

### Bugs

| What | Description |
|------|-------------|
| `checkAccess()` resource check bypass | When `identity.resources` is `undefined` (falsy), the resource access check at `call.ts:248` (`if (resourceType && resourceAction && identity.resources)`) evaluates to `false` and falls through to `return true` — granting access even though `resourceType`/`resourceAction` are declared on the operation. This means an identity without any declared resources passes resource-level access control for operations that require it. ADR-006's default-deny rule (`ACCESS_DENIED` when required scopes/resources are missing) would fix this. |
| `PendingRequestMap` type name conflict | `src/env.ts` exports a `PendingRequestMap` **interface** (reduced signature: missing `deadline`, `identity` typed as `unknown`). `src/call.ts` exports the **class** `PendingRequestMap` which has the full signature. `src/index.ts` re-exports the interface as `PendingRequestMap` and the class as `PendingRequestMapClass`. This naming creates confusion — the documented `PendingRequestMap` refers to the class, but importing the type gives the reduced interface. |

## References

- [response-envelopes.md](response-envelopes.md) — `ResponseEnvelope` types, factory functions, detection, and integration points
- [ADR-005](decisions/005-response-envelopes.md) — Design rationale for response envelopes
- [api-surface.md](api-surface.md) — Public API surface (types and signatures)
- [adapters.md](adapters.md) — MCP and OpenAPI adapter internals