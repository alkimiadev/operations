---
status: draft
last_updated: 2026-05-11
---

# ADR-006: Unified Invocation Path

## Context

We currently have **two ways to invoke an operation**:

1. **`registry.execute()`** — direct function call. Looks up spec and handler, validates input, calls the handler synchronously, warns on output validation. No access control, no identity propagation, no timeouts, no envelope wrapping, no cross-process transport.

2. **`callMap.call()`** — call protocol mode. Publishes `call.requested` via pubsub, stores a pending promise, resolves on `call.responded`. Supports identity, deadlines, parent request chaining, access control (on the handler side via `CallHandler`).

`buildEnv()` toggles between them with `if (callMap)`. `CallHandler` bypasses `execute()` entirely — it duplicates the lookup, validation, and handler invocation, adding access control but omitting output validation and envelope wrapping.

This is a **conflation point** — the call protocol events (`call.requested`, `call.responded`) conflate two patterns that should be distinct:

- **RPC request-response** (synchronous call disguised as paired events, correlated by `requestId`) — this is the "boomerang coupling" anti-pattern from our [event source types research](../../../../research/event_sourcing/event_source_types.md): publish a thin trigger, then require a callback to deliver the result.
- **Integration events** (cross-boundary communication for worker pools, WebSocket hubs) — properly decoupled, serializable, transport-agnostic.

Meanwhile `execute()` is a **domain call** — same-process, same-trust, rich types, no serialization. These are different concerns that happen to produce the same outcome (running an operation), but they have different semantics, different guarantees, and different failure modes.

### Why this is a problem now

- **Inconsistent guarantees**: Operations called via `execute()` skip access control and envelope wrapping. Operations called via `callMap.call()` skip output validation. Same operation, different behavior depending on invocation path.
- **Worker pool model**: We plan to spawn N workers that handle operations via the call protocol. In the current model, the main thread would use `callMap.call()` for remote operations and `execute()` for local ones — but the consumer shouldn't need to know the difference.
- **Envelope model consistency**: The response envelope spec (ADR-005) defines a result pipeline (detect → wrap → normalize → validate) that both `execute()` and `CallHandler` should follow. Currently, `execute()` does none of this and `CallHandler` does some of it. The dual path makes it hard to guarantee consistent behavior.
- **Security gap**: `execute()` skips access control entirely. An untrusted caller can invoke any operation through `execute()` without scope checks — the only protected path is via `CallHandler`.

### Prerequisites

This ADR depends on ADR-005 (response envelopes) being implemented in source first. **ADR-005 is now implemented** — `ResponseEnvelope` types, `isResponseEnvelope()`, and factory functions exist in `src/response-envelope.ts`. The prerequisite is met.

## Decision

**Unify on `execute()` as the single invocation entry point.** All consumers — local in-process code, `buildEnv()`, and future worker pool routers — call `registry.execute()` and get the same behavior: envelope wrapping, result pipeline, access control, consistent error handling.

The call protocol (`call.requested` / `call.responded` / `CallHandler` / `PendingRequestMap`) becomes an **internal transport mechanism** for routing invocations across process boundaries. It is not a public invocation path — it's the plumbing that `execute()` uses when the target handler is in another process.

### Architectural model

```
Consumer code (local, buildEnv, worker pool router)
        │
        ▼
  registry.execute(operationId, input, context)
        │
        │  ←── always: result pipeline (detect → wrap → normalize → validate)
        │  ←── always: access control (skip only if context.trusted)
        │  ←── always: returns Promise<ResponseEnvelope>
        │
        ├── target is local (handler in same registry)
        │       │
        │       ▼
        │   call handler directly, apply pipeline, return envelope
        │
        └── target is remote (handler in worker pool)
                │
                ▼
            publish call.requested via pubsub
                │
                ▼
            Worker: registry.execute() on worker side
            (access control, validation, handler, envelope pipeline)
                │
                ▼
            publish call.responded via pubsub
                │
                ▼
            PendingRequestMap resolves promise
                │
                ▼
            execute() returns envelope
```

Key: the **worker side also calls `registry.execute()`**. `CallHandler` on the worker side is a thin adapter that receives `call.requested` events, unpacks them into `operationId`/`input`/`context`, and calls `registry.execute()`. On error, it catches `CallError` and publishes `call.error`. This eliminates the code duplication where `CallHandler` currently reimplements lookup, validation, and access control.

### Security model

Access control is the key semantic difference between local trusted calls and remote untrusted calls. Under the unified path:

#### Default-deny: identity is required when access control is specified

When `spec.accessControl.requiredScopes` is non-empty and `context.identity` is absent, `execute()` **rejects with `ACCESS_DENIED`**. This closes the current security gap where `execute()` skips access control entirely.

Operations with empty `requiredScopes` (the default) are accessible without identity — this preserves the current behavior for operations that don't declare access requirements.

#### Trust flag for nested calls

```ts
interface OperationContext {
  // ... existing fields ...
  identity?: Identity
  trusted?: boolean  // INTERNAL: set by buildEnv(), not by callers
}
```

`trusted` is set by infrastructure (`buildEnv()`), not by external callers. When `context.trusted === true`, `execute()` skips `scope` and `resource` access control checks — the outer call already authenticated. This prevents redundant scope checks on every nested operation call within a trusted request chain.

`trusted` is **not** serialized in `call.requested` events. Remote calls always run access control — trust does not cross process boundaries.

#### Identity propagation

| Call type | `identity` | `trusted` | Access control |
|---|---|---|---|
| External (MCP, HTTP) | Set by transport adapter | `false` | Full check |
| Nested via `buildEnv()` | Propagated from outer context | `true` | Skipped (outer already checked) |
| Remote (worker pool) | From `call.requested.identity` | `false` | Full check |

`buildEnv()` functions propagate `context` (including `identity`) to `execute()`. For same-process nested calls, `trusted` is set automatically. For remote calls, `identity` is carried in the `call.requested` event — workers always run access control because trust doesn't cross boundaries.

#### `customAuth` is deferred

The `customAuth` field on `AccessControl` is declared but not yet enforced anywhere (current source has no implementation). Under the unified path, `customAuth` enforcement is out of scope — the hook point exists in the schema, but the mechanism for registering and calling custom auth functions is a future decision.

### Key changes

1. **`registry.execute()` is the only public invocation path.** It always returns `Promise<ResponseEnvelope<TOutput>>` (per the envelope spec). It always applies access control (unless `context.trusted`). It always applies the result pipeline.

2. **`buildEnv()` always uses `registry.execute()`.** The `callMap` option is removed from `buildEnv()`. `OperationEnv` functions call `execute()` directly. Nested calls propagate the same `context` (plus `trusted: true`).

3. **Call protocol is internal transport.** `PendingRequestMap`, `CallHandler`, and `CallEventSchema` become internal implementation details, not part of the public invocation API. They exist for cross-process routing only.

4. **`CallHandler` calls `registry.execute()` on the worker side.** Instead of duplicating lookup, validation, and access control, the worker-side `CallHandler` becomes a thin adapter:
   ```ts
   // Worker-side (conceptual, not public API)
   async function callHandler(event: CallRequestedEvent) {
     const context: OperationContext = {
       requestId: event.requestId,
       parentRequestId: event.parentRequestId,
       identity: event.identity,  // always present for remote calls
       // trusted is NOT set — remote calls always run access control
     }
     try {
       const envelope = await registry.execute(event.operationId, event.input, context)
       callMap.respond(event.requestId, envelope)
     } catch (error) {
       const callError = mapError(error)
       callMap.emitError(event.requestId, callError.code, callError.message, callError.details)
     }
   }
   ```
   This eliminates the code duplication between `execute()` and `CallHandler`.

5. **`execute()` routes to remote when handler is not local.** When the registry is configured with an `EventTarget` transport and the requested `operationId` has no local handler, `execute()` publishes `call.requested` and awaits the response. The consumer sees the same `Promise<ResponseEnvelope>` regardless.

### What stays the same

- **`PendingRequestMap`**: Still needed for routing `call.responded` back to the correct promise. Internal transport plumbing.
- **`CallEventSchema`**: Still the wire format for cross-process communication. Internal.
- **`subscribe()`**: Direct in-process subscriptions remain. They call the handler's async generator directly with envelope wrapping. `subscribe()` also applies access control when `identity` is present (consistent with `execute()`). Envelope wrapping per yield is addressed by ADR-005.
- **Adapters (`from_mcp`, `from_openapi`)**: Register handlers in the registry as before. Their handlers return `ResponseEnvelope` instances (via factory functions) as the envelope spec describes.

### What changes

| Before (dual path) | After (unified) |
|---|---|
| `execute()` returns `Promise<TOutput>` | `execute()` returns `Promise<ResponseEnvelope<TOutput>>` |
| `execute()` skips access control | `execute()` checks access control (skip if `context.trusted`) |
| `execute()` doesn't wrap in envelope | `execute()` applies result pipeline (detect → wrap → normalize → validate) |
| `buildEnv()` toggles `execute()` vs `callMap.call()` | `buildEnv()` always uses `execute()` |
| `CallHandler` duplicates handler invocation | `CallHandler` calls `registry.execute()` internally |
| `callMap` is a public concept | Call protocol is internal transport plumbing |
| Two different invocation guarantees | Same behavior regardless of local/remote |
| `OperationContext` has no `trusted` field | `OperationContext` gains `trusted?: boolean` |
| Identity not propagated through `buildEnv()` | `buildEnv()` propagates identity and sets `trusted: true` |

### Error handling

Under the unified path, `execute()` always throws `CallError` on failure:

- **Local calls**: `execute()` throws directly — `CallError(OPERATION_NOT_FOUND)`, `CallError(ACCESS_DENIED)`, `CallError(VALIDATION_ERROR)`, or a handler-thrown error mapped via `mapError()`.
- **Remote calls**: `execute()` publishes `call.requested` and awaits the response. If the worker's `CallHandler` catches an error, it publishes `call.error`. `PendingRequestMap` receives it and rejects the promise with `CallError`. `execute()` receives the rejection and rethrows it.

Both paths produce the same `CallError` type with the same error codes. The consumer catches `CallError` regardless of whether the call was local or remote.

For remote calls with timeouts: `PendingRequestMap`'s deadline timer produces `CallError(TIMEOUT)`. If the worker is unavailable, the promise never resolves until the deadline expires.

### `subscribe()` in the unified model

`subscribe()` is the third invocation path for `SUBSCRIPTION`-type operations. It calls the handler's async generator directly (no pubsub routing). Under the unified model:

- `subscribe()` checks access control when `identity` is present (consistent with `execute()`).
- `subscribe()` wraps each yield in `ResponseEnvelope` per ADR-005.
- `subscribe()` does NOT go through `execute()` — it calls the generator directly because subscriptions are streaming, not single-response.

Subscriptions are excluded from `OperationEnv` (as currently) — `buildEnv()` only provides QUERY and MUTATION operations.

## Consequences

### Positive

- **Single invocation path**: Consumers always call `execute()`. Same behavior, same guarantees, same return type. No `if (callMap)` toggles.
- **Consistent envelope wrapping**: Every invocation goes through the result pipeline. No more "did this come from execute() or callMap?" ambiguity.
- **Consistent access control**: No more unprotected path. Every call is checked when identity is present.
- **Worker pool ready**: The routing decision (local vs. remote) is an internal implementation detail of `execute()`, not a consumer concern.
- **Clear boundary**: The call protocol events are properly scoped as integration events (cross-boundary transport), not as a general-purpose invocation mechanism that coexists with a different invocation mechanism.
- **No code duplication**: Worker-side `CallHandler` calls `registry.execute()` instead of reimplementing lookup, validation, and access control.

### Negative

- **Performance for local calls**: `execute()` now applies access control, envelope wrapping, `Value.Cast()` normalization, and output validation on every call, even trusted same-process calls. The `trusted` flag skips redundant scope checks, but envelope wrapping and validation remain. Estimated overhead: ~1-5μs per call for envelope construction + detection + access check. This is acceptable for our use case (operations are typically milliseconds to seconds). Benchmark before stabilizing.
- **API change**: Removing `callMap` from `buildEnv()` and making call protocol internal is a breaking change. Package is pre-1.0; consumers are coordinated.
- **Complexity in `execute()`**: Routing logic (local vs. remote) adds conditional paths inside `execute()`. This is simpler than the current external toggle, but `execute()` becomes more complex internally.

### Risks

- **Premature abstraction**: Building remote routing into `execute()` before the worker pool exists could over-engineer. Mitigation: **implement local-only first** (envelope wrapping, access control, result pipeline in `execute()`). Add remote routing when the worker pool is built. The local-only implementation still eliminates the dual-path problem.
- **Two-phase implementation**: ADR-005 (response envelopes) must be implemented in source before ADR-006 can be implemented. The unified `execute()` requires `ResponseEnvelope` types and `isResponseEnvelope()` to exist. Track this dependency explicitly.
- **Trust flag misuse**: If `trusted` is accidentally set by external callers (not just `buildEnv()`), access control is bypassed. Mitigation: use a `Symbol`-keyed property or a frozen internal marker that external callers cannot construct.

## Migration plan

1. **Implement ADR-005 in source** — `ResponseEnvelope` types, factory functions, `isResponseEnvelope()`, schema constants in `src/response-envelope.ts`.
2. **Update `execute()`** — return `Promise<ResponseEnvelope<TOutput>>`, apply result pipeline (detect → wrap → normalize → validate), add access control check.
3. **Add `trusted` to `OperationContext`** — internal-only, set by `buildEnv()`.
4. **Update `buildEnv()`** — remove `callMap` option, always call `execute()`, propagate `context` with `trusted: true`.
5. **Simplify `CallHandler`** — thin adapter that calls `registry.execute()`, catches errors, publishes events.
6. **Update `subscribe()`** — add access control check, wrap yields in `ResponseEnvelope`.
7. **Update `OperationEnv` return type** — `Promise<unknown>` → `Promise<ResponseEnvelope>`.
8. **Add remote routing to `execute()`** — when EventTarget transport is configured on registry and handler is not local, publish `call.requested` and await response. (Deferred until worker pool is built.)
9. **Move call protocol exports** — `PendingRequestMap`, `CallHandler`, `CallEventSchema` move from public barrel to internal. `call()` and `respond()` become internal APIs.

## References

- [event_source_types.md](../../../../research/event_sourcing/event_source_types.md) — Research on event-driven conflation points and the "boomerang coupling" anti-pattern
- [ADR-005](005-response-envelopes.md) — Response envelope design rationale (prerequisite)
- [response-envelopes.md](../response-envelopes.md) — Envelope types and result pipeline
- [call-protocol.md](../call-protocol.md) — Call protocol spec
- [api-surface.md](../api-surface.md) — Public API surface