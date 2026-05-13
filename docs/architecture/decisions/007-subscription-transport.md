---
status: draft
last_updated: 2026-05-13
---

# ADR-007: Subscription Transport for SSE and Remote Streaming

## Context

`FromOpenAPI` detects SSE endpoints (`text/event-stream` → `SUBSCRIPTION`) but the current handler does a one-shot `fetch` and returns the response body. This means:

1. **Handler type mismatch**: `SUBSCRIPTION` operations get an `OperationHandler` (single-return) instead of a `SubscriptionHandler` (AsyncGenerator). They can't be consumed via `subscribe()`.

2. **No SSE stream parsing**: The handler returns the raw response body instead of yielding individual SSE events.

3. **No remote subscription transport**: `PendingRequestMap.call()` resolves after one `call.responded` event. There's no way to consume a subscription over a remote transport (WebSocket, Redis, etc.) — you get one response and the promise resolves, even if the operation yields multiple events.

4. **PubSub WebSocket is underutilized**: `@alkdev/pubsub` provides WebSocket client and server event targets with bidirectional `__subscribe`/`__unsubscribe` control events. The operations call protocol (`call.requested`/`call.responded`) could ride on this transport for remote subscriptions, but the plumbing doesn't exist yet.

### The core insight: `call ≡ subscribe`

The call protocol already defines this equivalence at the protocol level — same event types, same `requestId` correlation, same `PendingRequestMap`. The difference is consumption pattern:

- **`call`**: Publish `call.requested`, resolve on first `call.responded` → `Promise<ResponseEnvelope>`
- **`subscribe`**: Publish `call.requested`, yield each `call.responded` → `AsyncIterable<ResponseEnvelope>`

The `PendingRequestMap` currently only implements the `call` pattern. The `subscribe` pattern is missing from the remote transport path.

### PubSub transport

`@alkdev/pubsub` provides `createPubSub({ eventTarget })` where the event target can be:

| Transport | Use Case | EventTarget |
|-----------|----------|-------------|
| In-process | Local operations | Browser `EventTarget` (default) |
| Redis | Cross-process events | `RedisEventTarget` |
| WebSocket client | Spoke → Hub | `WebSocketClientEventTarget` |
| WebSocket server | Hub → Spoke fan-out | `WebSocketServerEventTarget` |

When `PendingRequestMap` is constructed with a WebSocket event target, all `call.requested`/`call.responded`/`call.error`/`call.aborted` events flow over the WebSocket. This already works for single-request/response calls. For subscriptions, we need the same events to flow continuously until the subscription is stopped.

## Decision

### 1. SSE subscription handlers are AsyncGenerators

`FromOpenAPI` generates `SubscriptionHandler` (AsyncGenerator) for `SUBSCRIPTION`-type operations. The handler:

1. Calls `fetch()` with the constructed URL, params, and auth headers
2. Reads the response body as a `ReadableStream`
3. Parses SSE frames per the WHATWG specification (`data:`, `event:`, `id:` fields)
4. Yields each parsed event wrapped in `httpEnvelope()` with `contentType: "text/event-stream"`
5. Closes the stream on iteration stop (in `finally` block)

This makes SSE operations consumable via `subscribe()` and compatible with the call protocol's subscription transport.

### 2. `PendingRequestMap.subscribe()` for remote subscriptions

Add a `subscribe()` method to `PendingRequestMap` that returns `AsyncIterable<ResponseEnvelope>`:

```ts
subscribe(
  operationId: string,
  input: unknown,
  options?: { parentRequestId?: string; deadline?: number; identity?: Identity },
): AsyncIterable<ResponseEnvelope>
```

- Publishes `call.requested` (same as `call()`)
- Uses a `Repeater` (from `@alkdev/pubsub`) keyed by `requestId`
- Pushes each `call.responded:{requestId}` event's `output` field to the repeater
- On `call.error:{requestId}`: throws from the iterator
- On `call.aborted:{requestId}`: closes the iterator (completes)
- On consumer iteration stop: publishes `call.aborted` and cleans up

The consumer iterates identically to `subscribe()`:

```ts
for await (const envelope of pendingRequestMap.subscribe("opensemaphore.events", input, { identity })) {
  // process each SSE event envelope
}
```

### 3. `CallHandler` dispatches on operation type

`CallHandler` checks the operation type and routes accordingly:

- **QUERY / MUTATION**: Call `registry.execute()`, publish single `call.responded` or `call.error`
- **SUBSCRIPTION**: Call `subscribe()`, publish `call.responded` for each yield, handle `call.aborted` by calling `generator.return()`

This means a single `call.requested` can produce multiple `call.responded` events with the same `requestId` — one per yielded value from the subscription handler.

### 4. SSE events use existing `httpEnvelope`

Individual SSE events are wrapped in `httpEnvelope()` with `contentType: "text/event-stream"`. No new `ResponseSource` type is needed because:

- SSE events are HTTP responses — the initial connection establishes status and headers
- The `contentType` field in `HTTPResponseMeta` already distinguishes `"text/event-stream"` from `"application/json"`
- Each yielded event carries the same `statusCode` and `headers` from the initial response
- Adding a separate `"sse"` source type would be premature — the `http` source with `contentType` discrimination is sufficient

If consumers need per-event SSE metadata (event type, last event ID), this can be carried in `envelope._meta` on the `OperationSpec` or added as a future `SSEResponseMeta` type.

### 5. SSE handler is runtime-agnostic

The handler uses the global `fetch()` API (available in Node 18+, Deno, Bun, browsers). `ReadableStream` and `TextDecoderStream` are also web standards. No platform-specific imports.

For environments where `fetch()` is not available, the consumer must provide a polyfill before calling `FromOpenAPI`. We do not inject or configure `fetch` — it is a global.

## Event Flow: Remote SSE Subscription

```
Spoke (client)                              Hub (server)
     │                                            │
     │─── call.requested ───────────────────────> │
     │     {requestId, operationId,               │
     │      input, identity}                       │
     │                                            │─ CallHandler checks type=SUBSCRIPTION
     │                                            │─ subscribe(registry, opId, input, ctx)
     │                                            │─ SSE handler: fetch() → parse stream
     │                                            │
     │<── call.responded:{requestId} ────────── │  (yield #1)
     │     {output: ResponseEnvelope}              │
     │                                            │
     │<── call.responded:{requestId} ────────── │  (yield #2)
     │     {output: ResponseEnvelope}              │
     │                                            │
     │      ...                                    │
     │                                            │
     │─── call.aborted ────────────────────────> │  (consumer done, stops iteration)
     │     {requestId}                             │─ generator.return() closes SSE stream
```

The spoke uses `PendingRequestMap.subscribe()` with a WebSocket event target. Each `call.responded` event flows through the pubsub transport. The hub-side `CallHandler` iterates the subscription handler's AsyncGenerator and publishes each yield.

## What Stays the Same

- **`subscribe()` direct function**: Local in-process subscription consumption. Calls the handler's AsyncGenerator directly, wraps yields in `ResponseEnvelope`. No pubsub transport involved.
- **`PendingRequestMap.call()`**: Single-request/response pattern. Publishes `call.requested`, resolves on first `call.responded`. Used for QUERY and MUTATION operations over remote transport.
- **`OperationHandler` vs `SubscriptionHandler` types**: `OperationHandler` returns a single value; `SubscriptionHandler` is an AsyncGenerator. The registry stores both.
- **Response envelope model**: All values are wrapped in `ResponseEnvelope` at the protocol boundary, regardless of transport.
- **`httpEnvelope()` factory**: Used by OpenAPI adapter for both single-return and SSE handlers.

## What Changes

| Before | After |
|--------|-------|
| SSE operations get `OperationHandler` (single-return) | SSE operations get `SubscriptionHandler` (AsyncGenerator) |
| SSE handler does one-shot `fetch` | SSE handler streams response body, yields per SSE event |
| `PendingRequestMap` has `call()` only | `PendingRequestMap` gains `subscribe()` method |
| `CallHandler` always calls `registry.execute()` | `CallHandler` dispatches: `execute()` for QUERY/MUTATION, `subscribe()` for SUBSCRIPTION |
| No remote subscription transport | Remote subscriptions over pubsub (WebSocket, Redis, etc.) |

## Consequences

### Positive

- **SSE operations work as subscriptions**: Consumable via `subscribe()` and `PendingRequestMap.subscribe()`
- **Unified subscription model**: Same `call ≡ subscribe` semantics for local and remote
- **Leverages existing pubsub transport**: No new transport code needed — `PendingRequestMap.subscribe()` uses the same `EventTarget` as `PendingRequestMap.call()`
- **Consistent envelope model**: SSE events wrapped in `httpEnvelope()`, same as single-return HTTP responses
- **Transport-agnostic**: SSE handler works with any pubsub transport in `PendingRequestMap`

### Negative

- **`PendingRequestMap` complexity**: Managing both `call()` and `subscribe()` subscriptions in the same instance introduces complexity for lifecycle management. The `call.responded:{requestId}` topic now either resolves a promise or pushes to a repeater, depending on whether the request was initiated via `call()` or `subscribe()`.
- **Backpressure on SSE streams**: If the hub produces SSE events faster than the spoke consumes them, events buffer in the WebSocket/transport. The `maxBufferedAmount` backpressure policy on the server-side event target disconnects slow consumers, but this is abrupt. A more graceful flow-control mechanism is deferred.
- **Subscription lifecycle**: `call.aborted` must reach the hub-side handler to close the SSE stream. If the transport drops, the hub may continue the SSE stream until it times out or the TCP connection closes. This is acceptable for SSE (which keeps the HTTP connection open), but requires consideration for long-lived subscriptions.

### Risks

- **Multiple `call.responded` per `requestId`**: The current `PendingRequestMap.call()` assumes one `call.responded` per `requestId` and then removes the pending request. With `subscribe()`, the `requestId` maps to a Repeater, not a promise. `PendingRequestMap` must track whether a `requestId` is a `call` or `subscribe` to route correctly. This increases internal complexity. See call-protocol.md § Internal Routing for the data structure.

- **SSIS parsing robustness**: The SSE specification has edge cases (reconnection via `Last-Event-ID`, BOM handling, empty data fields, partial lines across `read()` calls). The implementation must handle these gracefully but a comprehensive SSE parser test suite is needed.

- **Generator error propagation**: If the `SubscriptionHandler` throws mid-stream, `CallHandler` must catch the error, publish `call.error`, and clean up. This is straightforward but must be tested. Pre-generator errors (ACCESS_DENIED, VALIDATION_ERROR) are also caught and published as `call.error`.

- **Backpressure on SSE streams**: If the hub produces SSE events faster than the spoke consumes them, events buffer in the WebSocket/transport. The `maxBufferedAmount` backpressure policy on the server-side event target disconnects slow consumers, but this is abrupt. A more graceful flow-control mechanism is deferred.

## Open Questions

1. **SSEResponseMeta**: SSE events currently use `httpEnvelope()` with `contentType: "text/event-stream"`. The SSE `event` type and `id` fields are **dropped** by the current parser — they are not carried in the `ResponseEnvelope`. This means consumers that need per-event SSE metadata (event type for dispatch, last event ID for reconnection) cannot access it. The `data` field value (typically JSON) is the primary `envelope.data` payload. A future `SSEResponseMeta` with `source: "sse"`, `eventType: string`, `lastEventId: string` could carry this metadata. Deferred until usage patterns confirm the need.

2. **Deadline for subscriptions** — Resolved: `deadline` always means "idle timeout" (max time between yielded values), not a hard wall-clock cutoff. This accommodates two subscription patterns with a single field:

   - **Streaming** (LLM token streams, SSE event feeds): If no envelope arrives within `deadline` ms, the subscription is considered dead. This is the natural timeout — the stream is expected to produce events continuously.
   - **Watchdog** (network failure listeners, resource monitors): These subscriptions must stay alive indefinitely and fire only on rare events. A `deadline` alone would kill them. The handler must yield a heartbeat envelope at an interval shorter than `deadline` to prove liveness. The heartbeat is simply a `ResponseEnvelope` with a distinguishable shape (e.g., `_meta: { heartbeat: true }`); the consumer can filter or ignore heartbeats without protocol changes.

   No new protocol fields are needed. `deadline` semantics are uniform: "if I don't hear from you for this long, you're dead." Streaming handlers naturally satisfy this by yielding data. Watchdog handlers satisfy it by explicitly yielding no-op heartbeats. Hard wall-clock cutoffs are a consumer-side concern (call `abort()` when needed).

3. **Reconnection**: The SSE specification includes `Last-Event-ID` for automatic reconnection. Should the SSE handler support automatic reconnection with `Last-Event-ID`, or should that be the consumer's responsibility? A reconnecting handler would need to re-fetch with the `Last-Event-ID` header and resume the generator. This is complex and deferred until usage patterns confirm the need.

## References

- [adapters.md](../adapters.md) — FromOpenAPI adapter internals
- [call-protocol.md](../call-protocol.md) — Call protocol spec, PendingRequestMap, CallHandler
- [response-envelopes.md](../response-envelopes.md) — Envelope types and factory functions
- [ADR-006](006-unified-invocation-path.md) — Unified invocation path (execute as single entry point)
- SSE specification: https://html.spec.whatwg.org/multipage/server-sent-events.html
- `@alkdev/pubsub` event targets: WebSocket client, WebSocket server, Redis