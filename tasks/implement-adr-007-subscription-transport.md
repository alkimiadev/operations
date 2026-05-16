# Task: Implement ADR-007 Subscription Transport

**Priority**: High (blocks hub↔spoke streaming)

**Dependencies**: ADR-005 (done), ADR-006 (done). Heartbeat idle-timeout semantics settled in ADR-007 amended 2026-05-13.

**Architecture docs**: [ADR-007](../docs/architecture/decisions/007-subscription-transport.md), [call-protocol.md](../docs/architecture/call-protocol.md), [adapters.md](../docs/architecture/adapters.md)

**Status**: ✅ Completed (2026-05-16)

## Scope

Three changes, all in source. No new modules needed.

### 1. `PendingRequestMap.subscribe()` — Remote subscription transport (src/call.ts)

Add a `subscribe()` method that returns `AsyncIterable<ResponseEnvelope>` using `@alkdev/pubsub`'s Repeater.

**What to build**:

1. Add `PendingEntry` discriminated union to track whether a `requestId` is a single-resolution `call` or a multi-yield `subscribe`:
   ```ts
   type PendingEntry =
     | { type: "call"; promise: PendingRequest }
     | { type: "subscribe"; repeater: Repeater<ResponseEnvelope> }
   ```
   Replace `Map<string, PendingRequest>` with `Map<string, PendingEntry>`.

2. Add `subscribe()` method on `PendingRequestMap`:
   ```ts
   subscribe(
     operationId: string,
     input: unknown,
     options?: { parentRequestId?: string; deadline?: number; identity?: Identity },
   ): AsyncIterable<ResponseEnvelope>
   ```
   - Generate `requestId` via `crypto.randomUUID()`
   - Create a `Repeater<ResponseEnvelope>` from `@alkdev/pubsub`
   - Store `{ type: "subscribe", repeater }` in the map
   - Publish `call.requested` (same as `call()` does)
   - Return the Repeater as `AsyncIterable`

3. Update `setupSubscriptions()` event routing to handle both entry types:
   - `call.responded:{requestId}`: If `type: "call"` → resolve promise + delete. If `type: "subscribe"` → push to repeater (keep entry).
   - `call.error:{requestId}`: If `type: "call"` → reject promise + delete. If `type: "subscribe"` → push error to repeater then close repeater + delete.
   - `call.aborted:{requestId}`: If `type: "call"` → reject promise + delete. If `type: "subscribe"` → close repeater + delete.
   - Orphaned events (requestId not in map): silently ignore.

4. Implement heartbeat-based idle timeout for `subscribe()`:
   - When `deadline` is set on `subscribe()`, store it in the `PendingEntry.subscribe`.
   - In the `call.responded` handler for subscription entries, reset the deadline timer on each received envelope.
   - If the deadline timer fires (no envelope received within `deadline` ms), treat it as `TIMEOUT` — close the repeater, publish `call.aborted`, delete the entry.
   - Heartbeats from handlers are indistinguishable from data at the protocol level — a `ResponseEnvelope` with `_meta: { heartbeat: true }` is just another envelope that resets the deadline. Consumers filter heartbeats by inspecting `envelope._meta`.

5. Update `abort()` method: handle `type: "subscribe"` by closing the repeater.

6. Update `getPendingCount()`: count both call and subscribe entries.

### 2. CallHandler type dispatch (src/call.ts)

Update `buildCallHandler()` to check the operation's `type` and route accordingly:

- **QUERY / MUTATION**: Call `registry.execute()`, publish single `call.responded` or `call.error` (unchanged from current behavior)
- **SUBSCRIPTION**: Call `subscribe()`, iterate the generator, publish `call.responded` per yield, handle `call.aborted` by calling `generator.return()`

```ts
return async (event: CallRequestedEvent): Promise<void> => {
  const { requestId, operationId, input, identity } = event;
  const context: OperationContext = {
    requestId,
    parentRequestId: event.parentRequestId,
    identity,
  };
  try {
    const spec = registry.getSpec(operationId);
    if (!spec) {
      throw new CallError(InfrastructureErrorCode.OPERATION_NOT_FOUND, `Operation not found: ${operationId}`);
    }
    if (spec.type === OperationType.SUBSCRIPTION) {
      // Subscription path: iterate generator, publish per yield
      const generator = subscribe(registry, operationId, input, context);
      for await (const envelope of generator) {
        callMap.respond(requestId, envelope);
      }
    } else {
      // QUERY / MUTATION: single response
      const envelope = await registry.execute(operationId, input, context);
      callMap.respond(requestId, envelope);
    }
  } catch (error) {
    const spec = registry.getSpec(operationId);
    const callError = mapError(error, spec?.errorSchemas);
    callMap.emitError(requestId, callError.code, callError.message, callError.details);
  }
};
```

For subscription abort handling: `CallHandler` should subscribe to `call.aborted:{requestId}` (or use the existing `callMap` mechanism) and call `generator.return()` when an abort arrives. This can be deferred to a follow-on — the initial implementation can let the generator naturally complete or error out.

### 3. FromOpenAPI SSE AsyncGenerator handlers (src/from_openapi.ts)

Replace the single-return `OperationHandler` for `SUBSCRIPTION`-type operations with an `AsyncGenerator`-based `SubscriptionHandler`.

**What to build**:

1. Add SSE parser function `parseSSEFrames(buffer: string): { events: SSEEvent[], remaining: string }`:
   - Handle BOM (U+FEFF) at stream start
   - Split on `\n`, `\r\n`, `\r`
   - Parse `data:`, `event:`, `id:` fields per WHATWG spec
   - `:`-prefixed lines (comments) are ignored
   - Empty line dispatches buffered event
   - Partial lines across `read()` calls: retain `remaining` buffer, prepend to next chunk

2. Add `SSEEvent` interface:
   ```ts
   interface SSEEvent {
     data: string
     eventType: string
     lastEventId: string
   }
   ```

3. In `createHTTPOperation()`, when `opType === OperationType.SUBSCRIPTION`, generate a `SubscriptionHandler` instead of `OperationHandler`. The handler should:
   - Call `fetch()` with URL/params/auth (same as current)
   - On HTTP error, throw `CallError("EXECUTION_ERROR", ...)`
   - Read response body as `ReadableStream` via `response.body.getReader()`
   - Decode chunks with `TextDecoder`
   - Parse SSE frames from the text stream via `parseSSEFrames()`
   - Yield each parsed event wrapped in `httpEnvelope(data, { statusCode, headers, contentType: "text/event-stream" })`
   - In `finally` block: release the reader lock
   - Handle heartbeat yield if needed for long-lived SSE streams (TBD — initial pass can skip)

4. Update the return type of `createHTTPOperation()` and callers to handle the `OperationHandler | SubscriptionHandler` union:
   - `FromOpenAPI()` return type: `Array<OperationSpec & { handler: OperationHandler | SubscriptionHandler }>`
   - `FromOpenAPIFile()` and `FromOpenAPIUrl()` return types similarly

5. SSE `event` type and `id` fields: The parser parses them but they are NOT carried in the current `httpEnvelope()` — the `data` field value is the primary payload. If consumers need per-event metadata, a future `SSEResponseMeta` type can be added. This is out of scope for this task. Heartbeat detection (for filterable no-op envelopes) is also deferred.

## Tests

- `PendingRequestMap.subscribe()`: test with in-process EventTarget, verify Repeater yields each envelope, verify deadline kills after idle interval, verify abort cleans up, verify heartbeat resets deadline
- `CallHandler` dispatch: test QUERY/MUTATION path (execute), test SUBSCRIPTION path (subscribe + multiple responds), test error propagation
- SSE parser: test BOM, all line endings, multiple `data:` lines, `event:`/`id:` fields, comments, empty data, partial-line buffering, malformed lines
- `FromOpenAPI` SUBSCRIPTION handler: mock fetch returning a readable SSE stream, verify each event is yielded as httpEnvelope, verify error handling

## Acceptance Criteria

1. `PendingRequestMap.subscribe()` exists and returns `AsyncIterable<ResponseEnvelope>`
2. Multiple `call.responded` events with the same `requestId` route to the Repeater, not a single-resolution promise
3. Deadline timer fires as idle timeout (resets on each received envelope) for subscriptions
4. `CallHandler` dispatches QUERY/MUTATION to `execute()`, SUBSCRIPTION to `subscribe()`
5. SSE operations from `FromOpenAPI` are consumable as subscriptions
6. All existing tests still pass
7. TypeScript compiles clean (`npm run lint`)

## References

- `@alkdev/pubsub` Repeater API: see `src/repeater.ts` in `@alkdev/pubsub` source
- heartbeat idle timeout design: [ADR-007](../docs/architecture/decisions/007-subscription-transport.md) § Open Questions #2
- SSE spec: https://html.spec.whatwg.org/multipage/server-sent-events.html
