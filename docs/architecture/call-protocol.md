---
status: stable
last_updated: 2026-05-16
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

### `subscribe(operationId, input, options?)`

```ts
subscribe(
  operationId: string,
  input: unknown,
  options?: { parentRequestId?: string; deadline?: number; identity?: Identity },
): AsyncIterable<ResponseEnvelope>
```

The subscription counterpart to `call()`. Uses the same event types (`call.requested`, `call.responded`, `call.aborted`, `call.error`) and the same `requestId` correlation, but yields each `call.responded` event instead of resolving after the first one.

1. Generate `requestId` via `crypto.randomUUID()`
2. Create a `Repeater` (from `@alkdev/pubsub`) keyed by `requestId`
3. Publish `call.requested` event with all fields
4. Return the `Repeater` as `AsyncIterable<ResponseEnvelope>`
5. On each `call.responded:{requestId}` event: push `responded.output` to the repeater
6. On `call.error:{requestId}`: push the error (the Repeater throws from the iterator, then closes)
7. On `call.aborted:{requestId}`: close the repeater (iterator completes)
8. On consumer iteration stop: publish `call.aborted` and clean up

This enables remote subscriptions over any `EventTarget` transport. The consumer iterates:

```ts
for await (const envelope of pendingRequestMap.subscribe("opensemaphore.events", { repo: "alkdev/operations" }, { identity })) {
  // envelope is a ResponseEnvelope per SSE event
}
```

The handler on the other side must be an `AsyncGenerator` (i.e., a `SubscriptionHandler`). The `CallHandler` on the hub side calls `subscribe()` internally and publishes each yielded envelope as `call.responded`.

### Internal Routing: `call()` vs `subscribe()` per `requestId`

`PendingRequestMap` must track whether a given `requestId` belongs to a `call()` or a `subscribe()` to correctly route `call.responded` events. The internal data structure is:

```ts
type PendingEntry =
  | { type: "call"; promise: PendingRequest }      // single-resolution Promise
  | { type: "subscribe"; repeater: Repeater }       // multi-yield AsyncIterable
```

When `call.responded:{requestId}` arrives:
- If `type: "call"` → resolve the promise and delete the entry
- If `type: "subscribe"` → push `responded.output` to the repeater (entry persists until the stream ends)

When `call.error:{requestId}` arrives:
- If `type: "call"` → reject the promise and delete the entry
- If `type: "subscribe"` → push the error to the repeater (Repeater throws), then close the repeater and delete the entry

When `call.aborted:{requestId}` arrives:
- If `type: "call"` → reject the promise and delete the entry
- If `type: "subscribe"` → close the repeater (iterator completes), then delete the entry

Orphaned events (arriving after the consumer has stopped iterating or the entry was already deleted) are silently ignored — no error, no warning, no side effects.

#### Relationship to `subscribe()` direct function

| Aspect | `subscribe()` (direct) | `PendingRequestMap.subscribe()` |
|--------|----------------------|-------------------------------|
| Transport | In-process (calls handler directly) | Remote (via pubsub EventTarget) |
| Handler access | Registry lookup in same process | Hub side: registry lookup, handler call |
| Event routing | None — direct AsyncGenerator | `call.requested` → handler → `call.responded` per yield |
| Use case | Local subscriptions | Cross-process subscriptions (WebSocket, Redis, etc.) |
| Cleanup | Generator `return()` | Publish `call.aborted` + repeater stop |

Both return `AsyncIterable<ResponseEnvelope>` — same consumption pattern, different routing.

### Subscription Lifecycle

#### Error Propagation

| Scenario | `subscribe()` (direct) | `PendingRequestMap.subscribe()` |
|----------|----------------------|-------------------------------|
| Handler throws before first yield | `CallError` propagates to caller | `call.error` published, Repeater throws, consumer's `for await` catches the error |
| Handler throws mid-stream | Error propagates from generator, `finally` block runs | `call.error` published, Repeater throws, consumer's `for await` catches the error |
| Pre-handler errors (ACCESS_DENIED, VALIDATION_ERROR) | `CallError` thrown from `subscribe()` | `CallHandler` catches and publishes `call.error`, Repeater throws to consumer |
| `call.error` event arrives (remote) | N/A (in-process) | Repeater receives error, consumer's `for await` sees it |

#### Cleanup

| Scenario | `subscribe()` (direct) | `PendingRequestMap.subscribe()` |
|----------|----------------------|-------------------------------|
| Consumer stops iteration (`break`) | `generator.return()` called in `finally` | `call.aborted` published, Repeater closed, hub's `CallHandler` receives abort and calls `generator.return()` |
| Consumer's `for await` completes naturally | Generator's `return()` called if `finally` block has cleanup | Repeater stops, no `call.aborted` published |
| Transport disconnect | N/A (in-process) | Hub may continue until timeout/closure; no heartbeat specified yet (see open questions) |

#### Abortion

When a consumer calls `pendingRequestMap.abort(requestId)` for a subscription:
1. `call.aborted:{requestId}` is published to the pubsub
2. The Repeater is closed (consumer's `for await` loop ends)
3. The hub-side `CallHandler` receives `call.aborted`, calls `generator.return()` on the subscription handler (triggers `finally` block for stream cleanup)

When the direct `subscribe()` consumer breaks out of iteration, the generator's `finally` block runs automatically — no `call.aborted` event needed (in-process, no transport).

## CallHandler

`buildCallHandler` creates a function that bridges pubsub events to `OperationRegistry.execute()` or `subscribe()`. It delegates to `execute()` for QUERY/MUTATION operations and to `subscribe()` for SUBSCRIPTION operations.

```ts
function buildCallHandler(config: CallHandlerConfig): CallHandler

interface CallHandlerConfig {
  registry: OperationRegistry
  callMap?: PendingRequestMap
}

type CallHandler = (event: CallRequestedEvent) => Promise<void>
```

### Handler Flow

1. Construct `OperationContext` from the event (`requestId`, `parentRequestId`, `identity` — `trusted` is NOT set, remote calls always run access control)
2. Look up the operation spec via `registry.getSpec(operationId)`
3. If spec not found → publish `call.error` with `OPERATION_NOT_FOUND`
4. If spec type is `QUERY` or `MUTATION`:
   a. Call `registry.execute(operationId, input, context)` — this performs all validation, access control, and result pipeline
   b. On success: publish `call.responded` via `callMap.respond(requestId, envelope)`
   c. On failure: `mapError` converts the thrown value to `CallError`, publish `call.error`
5. If spec type is `SUBSCRIPTION`:
   a. Call `subscribe(registry, operationId, input, context)` — this checks access control and wraps yields in `ResponseEnvelope`
   b. For each yielded envelope: publish `call.responded` via `callMap.respond(requestId, envelope)`
   c. On generator completion: iterator ends naturally
   d. On generator error: `mapError` converts the error, publish `call.error`
   e. On `call.aborted:{requestId}`: call `generator.return()` to clean up the subscription

**Note on ADR-006**: [ADR-006](decisions/006-unified-invocation-path.md) specifies that `CallHandler` should be a "thin adapter that calls `registry.execute()`." For QUERY/MUTATION operations, this is the case. For SUBSCRIPTION operations, `CallHandler` must call `subscribe()` directly because `execute()` is designed for single-return operations (it `await`s the handler return value). Making `execute()` aware of SUBSCRIPTION type and routing to `subscribe()` internally would conflate two execution models in one function. The explicit dispatch in `CallHandler` is the correct design — `execute()` handles single-return operations, `subscribe()` handles streaming operations, and `CallHandler` routes between them based on `spec.type`.

**Handling pre-generator errors**: Both `registry.execute()` and `subscribe()` can throw before reaching the handler (e.g., `OPERATION_NOT_FOUND`, `ACCESS_DENIED`, `VALIDATION_ERROR`). `CallHandler` wraps the entire invocation in a try/catch, so these pre-generator errors are caught and published as `call.error`. For subscriptions, this means errors during access control, validation, or spec/handler lookup are reported via `call.error`, not silently swallowed.

**Key change**: In the pre-envelope model, handlers were responsible for publishing `call.responded` themselves (the handler return value was discarded). In the envelope model, `CallHandler` owns wrapping and publishing. Handler return values are captured and wrapped. This ensures every response goes through the envelope pipeline — no raw values can bypass it.

### Subscription Handling Detail

For `SUBSCRIPTION` operations, the `CallHandler` iterates the async generator and publishes each yield as `call.responded`. This means a single `call.requested` event can produce **multiple** `call.responded` events with the same `requestId`. The `PendingRequestMap.subscribe()` method consumes this stream.

The `call.aborted` event terminates the subscription. When the hub-side `CallHandler` receives `call.aborted:{requestId}`, it calls `generator.return()` on the active subscription handler. This triggers the generator's `finally` block (stream cleanup, resource release).

### MCP and OpenAPI Handlers

Adapter handlers (from `from_mcp` and `from_openapi`) return pre-built `ResponseEnvelope` instances via `mcpEnvelope()` and `httpEnvelope()` factory functions. When `CallHandler` detects `isResponseEnvelope()` on the result, it passes through without re-wrapping. This means adapter metadata (HTTP status codes, MCP `isError` flags) is preserved.

For MCP results with `meta.isError: true`, the handler still returns an envelope — the error is represented as data, not thrown. Only thrown exceptions trigger `call.error`.

## Access Control

### Enforcement Points

Access control is enforced in two places:

1. **`registry.execute()`** — Checks `accessControl` on every invocation. Skips access control when `context.trusted === true` (nested calls from `buildEnv()`). When `requiredScopes` is non-empty and no `identity` is present, rejects with `ACCESS_DENIED`.

2. **`subscribe()`** — Checks `accessControl` when called. Skips access control when `context.trusted === true`. Same default-deny logic as `execute()`.

3. **`CallHandler`** — Delegates to `registry.execute()`, which performs access control. `CallHandler` does NOT set `trusted` on the context — remote calls always run access control because trust does not cross process boundaries.

### Flow

```
invoke execute(operationId, input, context)
  → if context.trusted → skip access control
  → if requiredScopes/requiredScopesAny/resourceType non-empty and no identity → ACCESS_DENIED
  → else check identity against accessControl
    → all pass → proceed to execute
    → any fail → ACCESS_DENIED
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

- **Unified mode**: `buildEnv({ registry, context })` — env functions call `registry.execute()` directly, returning `Promise<ResponseEnvelope>`. The context is propagated with `trusted: true` so nested calls skip redundant access control checks.

`parentRequestId` enables call graph reconstruction and abort cascading — every nested call includes it.

## Transport Mapping

The call protocol is transport-agnostic. The `PubSub` event target determines how events move:

| Transport | Use Case | EventTarget impl |
|-----------|----------|-----------------|
| In-process | Local hub operations | Browser `EventTarget` (default) |
| Redis | Cross-process events | `RedisEventTarget` (from `@alkdev/pubsub`) |
| WebSocket client | Spoke → Hub bidirectional | `WebSocketClientEventTarget` (from `@alkdev/pubsub`) |
| WebSocket server | Hub → Spoke fan-out | `WebSocketServerEventTarget` (from `@alkdev/pubsub`) |

Same protocol, same event shapes, same `PendingRequestMap` — different `eventTarget`. Both `call()` and `subscribe()` work over any transport — the only difference is consumption pattern (single-resolution Promise vs. AsyncIterable).

### WebSocket Topology

The WebSocket event targets from `@alkdev/pubsub` carry call protocol events between hub and spoke processes:

```
Spoke process                              Hub process
     │                                           │
     │  createPubSub({                           │  createPubSub({
     │    eventTarget:                           │    eventTarget:
     │      WebSocketClientET                    │      WebSocketServerET
     │  })                                       │  })
     │                                           │
     │  pendingRequestMap                        │
     │    .call(op, input) ── ws ──────────────> │  CallHandler → execute()
     │    .subscribe(op, input) ── ws ─────────> │  CallHandler → subscribe()
     │                                           │
     │  <── call.responded ────────────────── ws │
     │  <── call.responded ────────────────── ws │  (multiple for subscribe)
     │  <── call.error ────────────────────── ws │
```

The WebSocket client adapter handles `__subscribe`/`__unsubscribe` control events automatically — when `PendingRequestMap` subscribes to `call.responded:{requestId}`, the client adapter sends `__subscribe` for that topic, and the server adapter routes only matching events to that spoke. See [ADR-003](../../../@alkdev/pubsub/docs/architecture/decisions/003-subscription-control-protocol.md) in `@alkdev/pubsub`.

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

Gets the operation spec and checks access control (same default-deny logic as `execute()` — rejects with `ACCESS_DENIED` when `requiredScopes` is non-empty and no `identity` is present; skips check when `context.trusted`). Then casts the handler to `AsyncGenerator` and yields each value wrapped in `ResponseEnvelope`. If a yielded value `isResponseEnvelope()`, it passes through (e.g., for adapter handlers). Otherwise, `localEnvelope(value, operationId)` wraps it with a fresh `timestamp` per yield. Properly cleans up with `generator.return()` in a `finally` block.

Use `subscribe()` for in-process consumption. Use `PendingRequestMap.call()` for cross-transport invocation that resolves after one event. For cross-transport streaming, use `PendingRequestMap.subscribe()` to yield multiple events.

### Handler Separation

The `subscribe()` function looks up both spec and handler separately from the registry:

1. `registry.getSpec(operationId)` — throws if spec not found
2. `registry.getHandler(operationId)` — throws if handler not found

This allows spec-only registration for scenarios where handlers are provided separately (e.g., ujsx host interpretation, dynamic handler injection).

## References

- [response-envelopes.md](response-envelopes.md) — `ResponseEnvelope` types, factory functions, detection, and integration points
- [ADR-005](decisions/005-response-envelopes.md) — Design rationale for response envelopes
- [api-surface.md](api-surface.md) — Public API surface (types and signatures)
- [adapters.md](adapters.md) — MCP and OpenAPI adapter internals