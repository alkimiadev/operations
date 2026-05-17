# Subscriptions

Subscription operations stream results over time using async generators. There are two ways to use them:

1. **Direct** — `subscribe()` calls the handler in-process, no pubsub needed
2. **Via call protocol** — `PendingRequestMap.subscribe()` routes through the pubsub layer

## Defining a Subscription Operation

Subscription handlers must be **async generator functions** (`async function*`):

```ts
import { Type } from "@alkdev/typebox";
import { OperationType } from "@alkdev/operations";

const watchTasks = {
  name: "watch",
  namespace: "task",
  version: "1.0.0",
  type: OperationType.SUBSCRIPTION,
  description: "Watch for task changes",
  inputSchema: Type.Object({ filter: Type.Optional(Type.String()) }),
  outputSchema: Type.Object({ id: Type.String(), title: Type.String(), status: Type.String() }),
  accessControl: { requiredScopes: ["task:read"] },
  handler: async function* (input, context) {
    for (const event of someEventSource(input.filter)) {
      yield event;
    }
  },
};
```

> The registry validates at registration time that subscription handlers are async generators. A regular async function will throw.

## Direct Subscription: `subscribe()`

The `subscribe()` function executes a subscription handler and returns an async generator. No pubsub or call protocol needed.

```ts
import { subscribe } from "@alkdev/operations";

const stream = subscribe(registry, "task.watch", { filter: "important" }, context);

for await (const envelope of stream) {
  console.log(envelope.data);
}
```

`subscribe()`:
1. Looks up the spec and handler
2. Enforces access control
3. Validates input
4. Verifies the handler returns an async iterable
5. Yields each value, wrapping non-envelope values in `localEnvelope()`

### Error handling

If the handler throws, the error propagates as a `CallError`. If the handler yields a non-iterable, `subscribe()` throws `EXECUTION_ERROR`.

### Cleanup

When the consumer breaks out of the `for await` loop, `subscribe()` calls `generator.return()` to clean up the handler.

## Call Protocol Subscription

When routing through `PendingRequestMap`:

```ts
const stream = callMap.subscribe("task.watch", { filter: "important" }, {
  idleTimeout: 30000,
  identity: { id: "user-1", scopes: ["task:read"] },
});

for await (const envelope of stream) {
  console.log(envelope.data);
}
```

The `CallHandler` will:
1. Call `subscribe()` on the registry
2. Stream each yielded envelope via `callMap.respond()`
3. Call `callMap.complete()` when the generator finishes
4. Call `callMap.emitError()` if an error occurs

## Choosing Between Direct and Call Protocol

| | Direct (`subscribe()`) | Call Protocol (`callMap.subscribe()`) |
|---|---|---|
| **Use when** | In-process, same runtime | Cross-process, remote callers |
| **Transport** | Direct function call | PubSub events |
| **Timeout** | Managed by consumer | `idleTimeout` parameter |
| **Abort** | Consumer breaks loop | `callMap.abort(requestId)` |