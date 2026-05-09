---
status: draft
last_updated: 2026-05-09
---

# Call Protocol

PendingRequestMap, CallHandler, call≡subscribe semantics, event types, error model, and access control.

## Overview

The call protocol is the unified transport layer for all operation invocations. It provides a single event-based mechanism that works the same whether the call is local (in-process), remote (hub↔spoke over websocket), or streamed (subscription). It is built on `@alkdev/pubsub`.

At the protocol level, `call` and `subscribe` are the same thing with different consumption patterns:

- **`call`**: Publish `call.requested`, subscribe to `call.responded:{requestId}`, resolve on first response → `Promise<TOutput>`
- **`subscribe`**: Publish `call.requested`, subscribe to `call.responded:{requestId}`, yield each response → `AsyncIterable<TOutput>`

Both use the same event types, the same `requestId` correlation, and the same `PendingRequestMap`. `call` is semantically `subscribe().next()`.

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
    output: Type.Unknown(),
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

### Request Correlation

Every call has a unique `requestId` (UUID). Nested calls include `parentRequestId` to track the call chain. Responses and errors match to requests by `requestId`.

### Event Flow

```
Caller                              Handler
  │                                    │
  │─── call.requested ───────────────>│
  │     {requestId, operationId,       │
  │      input, identity, deadline}   │
  │                                    │
  │<── call.responded ────────────────│
  │     {requestId, output}           │
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
): Promise<unknown>
```

1. Generate `requestId` via `crypto.randomUUID()`
2. Create a `PendingRequest` with `resolve`/`reject` from a new Promise
3. If `deadline` is set, start a timeout timer that rejects with `TIMEOUT`
4. Store `PendingRequest` in the internal map
5. Publish `call.requested` event with all fields
6. Return the Promise (resolves on `call.responded`, rejects on `call.error` or `call.aborted`)

### Internal Subscription Wiring

On construction, three async loops subscribe to pubsub topics:

- **`call.responded`**: Look up `PendingRequest` by `requestId`, clear timer if set, resolve with `output`
- **`call.error`**: Look up `PendingRequest`, clear timer, reject with `CallError(code, message, details)`
- **`call.aborted`**: Look up `PendingRequest`, clear timer, reject with `CallError(ABORTED, ...)`

### `respond(requestId, output)`

Publishes `call.responded`. Used by handlers to send results back through the protocol.

### `emitError(requestId, code, message, details?)`

Publishes `call.error`. Used by handlers to send errors.

### `abort(requestId)`

Looks up the `PendingRequest`, clears its timer, publishes `call.aborted`, rejects the Promise with `CallError(ABORTED, ...)`.

## CallHandler

`buildCallHandler` creates a function that bridges pubsub events to `OperationRegistry.execute()`.

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
8. On success: the handler is expected to have published `call.responded` through whatever mechanism
9. On failure: `mapError` converts the thrown value to `CallError`

The `CallHandler` is designed to be wired into a pubsub subscription:

```ts
const callHandler = buildCallHandler({ registry, eventTarget })
pubsub.subscribe("call.requested", callHandler)
```

## Access Control

### Enforcement Point

`CallHandler` enforces `AccessControl` before dispatching to `registry.execute()`. Direct `registry.execute()` calls bypass access control — this is by design for trusted internal calls.

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

- **Direct mode**: `buildEnv({ registry, context })` — env functions call `registry.execute()` directly
- **Call protocol mode**: `buildEnv({ registry, context, callMap })` — env functions call `callMap.call()`, publishing `call.requested` events with `parentRequestId` propagation

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
): AsyncGenerator<unknown, void, unknown>
```

Gets the operation from the registry, casts its handler to `AsyncGenerator`, and yields values. Properly cleans up with `generator.return()` in a `finally` block.

Use `subscribe()` for in-process consumption. Use `PendingRequestMap.call()` for cross-transport invocation that resolves after one event. For cross-transport streaming, use `PendingRequestMap.subscribe()` to yield multiple events.

### Handler Separation

The `subscribe()` function looks up both spec and handler separately from the registry:

1. `registry.getSpec(operationId)` — throws if spec not found
2. `registry.getHandler(operationId)` — throws if handler not found

This allows spec-only registration for scenarios where handlers are provided separately (e.g., ujsx host interpretation, dynamic handler injection).