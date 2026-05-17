# Call Protocol

The call protocol provides event-based operation invocation via `@alkdev/pubsub`. It uses the same events and `PendingRequestMap` for both one-shot calls and streaming subscriptions. The key insight: **call ≡ subscribe** — a call resolves after one response event; a subscription yields events until completed or aborted.

## PendingRequestMap

`PendingRequestMap` is the core of the call protocol. It manages pending calls and subscriptions through a pubsub layer.

### Creating a CallMap

```ts
import { PendingRequestMap } from "@alkdev/operations";

const callMap = new PendingRequestMap();
```

Optionally pass an `EventTarget` for cross-window/cross-worker communication:

```ts
const callMap = new PendingRequestMap(myEventTarget);
```

### Making a Call

```ts
const envelope = await callMap.call("task.create", { title: "Ship it" }, {
  deadline: Date.now() + 5000,
  identity: { id: "user-1", scopes: ["task:write"] },
});
```

This:
1. Creates a unique `requestId`
2. Publishes a `call.requested` event
3. Returns a `Promise<ResponseEnvelope>` that resolves when `respond()` is called with that `requestId`

### Subscribing

```ts
const stream = callMap.subscribe("events.watch", { filter: "important" }, {
  idleTimeout: 30000,
  identity: { id: "user-1", scopes: ["events:read"] },
});

for await (const envelope of stream) {
  console.log(envelope.data);
}
```

This:
1. Creates a unique `requestId`
2. Publishes a `call.requested` event (same as a call)
3. Returns an `AsyncIterable<ResponseEnvelope>` that yields events until `completed`, `aborted`, or idle timeout

### Responding

```ts
callMap.respond(requestId, envelope);
```

Sends a `call.responded` event. For calls, this resolves the promise. For subscriptions, this yields the next event.

### Error Handling

```ts
callMap.emitError(requestId, "VALIDATION_ERROR", "Input was invalid", { field: "title" });
```

Sends a `call.error` event. For calls, this rejects the promise with a `CallError`. For subscriptions, this stops the stream with an error.

### Completing a Subscription

```ts
callMap.complete(requestId);
```

Signals that no more events will be sent. Ends the subscription stream.

### Aborting

```ts
callMap.abort(requestId);
```

Aborts a pending call or subscription. Rejects the call promise or stops the subscription stream with an `ABORTED` error code.

## CallHandler

`buildCallHandler()` wires a `PendingRequestMap` to an `OperationRegistry`. It listens for `call.requested` events and routes them through the registry.

```ts
import { PendingRequestMap, buildCallHandler } from "@alkdev/operations";

const callMap = new PendingRequestMap();
const handler = buildCallHandler({ registry, callMap });

callMap["call.requested"].subscribe(handler);
```

The handler:
1. Extracts `operationId`, `input`, and `identity` from the event
2. For queries/mutations: calls `registry.execute()` and responds with the result
3. For subscriptions: delegates to `subscribe()` and streams results back
4. On error: calls `callMap.emitError()` with a mapped `CallError`

## Event Types

| Event | Purpose | Producer | Consumer |
|-------|---------|----------|----------|
| `call.requested` | Initiate a call or subscription | Caller | Handler |
| `call.responded` | Deliver a result | Handler | Caller |
| `call.completed` | Signal end of subscription | Handler | Caller |
| `call.aborted` | Cancel request | Caller or Handler | Opposite side |
| `call.error` | Signal an error | Handler | Caller |

Each event carries a `requestId` for correlation.

## Event Schemas

All events are typed TypeBox schemas available as `CallEventMap`:

```ts
import { CallEventMap } from "@alkdev/operations";

// Access type schemas:
CallEventMap["call.requested"]  // TypeBox schema
CallEventMap["call.responded"]   // TypeBox schema
```

## Timeout Behavior

**Calls** use `deadline` — an absolute timestamp (ms since epoch). If the deadline passes without a response, the promise rejects with a `TIMEOUT` error.

**Subscriptions** use `idleTimeout` — a relative duration (ms). If no event is received within this window, the subscription is aborted with a `TIMEOUT` error.

## Usage Pattern

A typical server setup:

```ts
const registry = new OperationRegistry();
const callMap = new PendingRequestMap();
const handler = buildCallHandler({ registry, callMap });

// Wire to your transport (WebSocket, HTTP, etc.)
transport.on("call.requested", handler);

// Or directly use the registry for in-process calls:
const result = await registry.execute("task.create", input, ctx);
```

See [Subscriptions](subscriptions.md) for the direct async generator approach (no pubsub needed).