# Pre-Release Review: @alkdev/operations

**Date:** 2026-05-16
**Scope:** Full codebase review for issues that would impact downstream hub/spoke implementations
**Status:** C-01 through C-05, H-01 through H-06, M-01 through M-08, and L-01 through L-05 resolved. L-04 resolved.

---

## Critical (must fix before downstream use)

### C-01. Duplicated access control logic between registry.execute() and subscribe()

**Files:** `src/registry.ts:107-124`, `src/subscribe.ts:33-51`

`subscribe()` copy-pastes the access control check from `registry.execute()` instead of calling `checkAccess()`. The inline version has slightly different error message formatting and will silently diverge from registry behavior when `customAuth` or any new access control feature is added.

Both paths should call `checkAccess()` directly, and the inline error-throwing logic should be extracted into a shared helper (e.g., `enforceAccess()` or similar).

### C-02. subscribe() skips input validation

**File:** `src/subscribe.ts` (full file)

`registry.execute()` calls `validateOrThrow(spec.inputSchema, input)` before invoking the handler. `subscribe()` does not validate input at all — it checks access then calls the handler directly. Invalid input won't fail until deep in handler code with an unhelpful error.

### C-03. Unhandled promise rejections in PendingRequestMap.setupSubscriptions()

**File:** `src/call.ts:93-113, 115-133, 135-153`

Three async IIFEs `(async () => { ... })()` are started in `setupSubscriptions()` with no `.catch()` handler. If any of these async iterators throw (pubsub error, connection loss, etc.), the promise rejection is unhandled and will crash the process under Node.js `--unhandled-rejections=throw` (the default since Node 15).

Each IIFE should have a `.catch()` that logs the error and optionally re-throws or signals failure.

### C-04. MCP adapter never surfaces isError: true as failure

**File:** `src/from_mcp.ts:130-159`

When an MCP tool call returns `{ isError: true }`, the handler wraps it in a normal `mcpEnvelope` with `meta.isError: true`. This means `registry.execute()` returns what appears to be a successful `ResponseEnvelope`. Downstream consumers must manually check `meta.isError` — easy to miss.

The OpenAPI adapter consistently throws `CallError` on HTTP error statuses (4xx/5xx). The MCP adapter should do the same when `result.isError === true`, wrapping the error content in a `CallError` rather than a successful envelope.

### C-05. from_openapi.ts uses bare string "EXECUTION_ERROR" instead of InfrastructureErrorCode enum

**File:** `src/from_openapi.ts:361, 453`

Uses `"EXECUTION_ERROR"` as a string literal instead of `InfrastructureErrorCode.EXECUTION_ERROR`. If the enum value ever changes or is refactored, these sites will silently break. All other modules use the enum constant.

---

## High (should fix before downstream use)

### H-01. customAuth defined in AccessControlSchema but never enforced

**File:** `src/types.ts:60` defines `customAuth: Type.Optional(Type.String())`
**File:** `src/access.ts` — `checkAccess()` never references `accessControl.customAuth`

If a hub/spoke author defines `customAuth` on an operation's access control, it is silently ignored. This creates a false sense of security. Either implement the custom auth hook mechanism or remove the field until it can be properly supported.

### H-02. context.metadata not propagated through buildCallHandler

**File:** `src/call.ts:286-290`

The `CallRequestedEvent` schema does not include a `metadata` field. When `buildCallHandler` constructs the `OperationContext`, it only sets `requestId`, `parentRequestId`, and `identity`. Any caller-provided metadata is silently dropped at the call protocol boundary.

The `CallRequestedEvent` type should include an optional `metadata` field, and `buildCallHandler` should propagate it to the context.

### H-03. OperationContext.stream and pubsub are typed but never populated

**File:** `src/types.ts:36-38`

```typescript
export type OperationContext = OperationContextBase & {
  env?: OperationEnv
  stream?: () => AsyncIterable<unknown>
  pubsub?: unknown
}
```

Neither `stream` nor `pubsub` are ever set by the library. `registry.execute()` constructs context without them. Downstream consumers who see these on the type will expect them to work and will get `undefined`.

Either implement these or remove them from the type and add them back when the feature is ready. Leaving dead stubs on the public API surface is worse than not having them.

### H-04. MCP handler discards context parameter entirely

**File:** `src/from_mcp.ts:130`

```typescript
handler: async (input: unknown) => {
```

The handler signature only takes `input`, discarding the `context` parameter. This means identity, request tracing, and metadata cannot flow through to MCP tool calls. The handler should at minimum propagate `context.identity` or a subset of context to the MCP call.

### H-05. Hard-coded version "1.0.0" in both adapters

**File:** `src/from_mcp.ts:123` — All MCP tools get `version: "1.0.0"`
**File:** `src/from_openapi.ts:399, 476` — All OpenAPI operations get `version: "1.0.0"`

Both adapters have access to version information (MCP server info, OpenAPI `info.version`) but ignore it. The MCP adapter should use the server version from `client.getServerVersion()` or accept a configurable default. The OpenAPI adapter should use `spec.info.version`.

### H-06. from_openapi.ts uses import("node:fs/promises") directly — not runtime-agnostic

**File:** `src/from_openapi.ts:518`

`FromOpenAPIFile` does `const { readFile } = await import("node:fs/promises")`. This violates the project constraint of runtime-agnostic code. The `OpenAPIFS` interface exists but `FromOpenAPIFile` bypasses it with a direct Node import. Should inject the file read like `scanner.ts` does with `ScannerFS`, or `FromOpenAPIFile` should accept an `OpenAPIFS` parameter.

---

## Medium (fix in follow-up)

### M-01. Duplicate OperationDefinitionSchema vs OperationSpecSchema ✅ RESOLVED

**File:** `src/types.ts`

**Resolution:** `OperationDefinitionSchema` now composes from `OperationSpecSchema` via `Type.Intersect([OperationSpecSchema, Type.Object({ handler: ... })])` instead of duplicating all fields. `OperationSpecSchema` is the single source of truth.

### M-02. No subpath export for from_openapi ✅ RESOLVED

**File:** `package.json`, `tsup.config.ts`, `src/index.ts`

**Resolution:** Added `./from-openapi` subpath export in `package.json` and `tsup.config.ts`. Removed `from_openapi` re-exports from `src/index.ts` so it's only available via `@alkdev/operations/from-openapi`.

### M-03. Subscription deadline semantics are ambiguous ✅ RESOLVED

**File:** `src/call.ts`

**Resolution:** Split the overloaded `deadline` field into two distinct concepts:

- `deadline` (absolute timestamp, ms since epoch) — used by `call()`. Total time limit for a request/response cycle. Computed as `setTimeout(fn, Math.max(0, deadline - Date.now()))`.
- `idleTimeout` (relative duration in ms) — used by `subscribe()`. Maximum ms between events before the subscription is considered idle. Reset on each `call.responded` event. Omit for no idle timeout (subscription lives until explicit abort).

`CallRequestedEvent` schema now has both `deadline?: number` and `idleTimeout?: number` as optional fields. `PendingRequestMap.subscribe()` accepts `{ idleTimeout }` instead of `{ deadline }`. The idle timer is correctly reset on each event using the stored `idleTimeout` value.

### M-04. No unsubscribe/completion signaling in call protocol ✅ RESOLVED

**File:** `src/call.ts`

**Resolution:** Added `call.completed` event type to the call protocol. When a subscription's async generator finishes naturally, `buildCallHandler` now calls `callMap.complete(requestId)` which publishes a `call.completed` event. The `PendingRequestMap` handles this event by closing the consumer's Repeater iterator (for subscriptions) or rejecting the pending promise (for calls). Added `CallCompletedEvent` type and schema, `complete()` method on `PendingRequestMap`, and a pubsub listener for `call.completed` in `setupSubscriptions()`. The `consumerStopped` flag is set before `stop()` to prevent spurious `call.aborted` events.

### M-05. mapError uses fragile message.includes(code) matching ✅ RESOLVED

**File:** `src/error.ts`

**Resolution:** Changed `message.includes(schema.code)` to `message.startsWith(schema.code + ":") || message === schema.code`. This prevents false positives like `"ITEM_NOT_FOUND"` matching `NOT_FOUND` while preserving the existing `"CODE: message"` pattern.

### M-06. from_mcp.ts uses multiple `any` casts ✅ RESOLVED

**File:** `src/from_mcp.ts`

**Resolution:** Replaced all `any` casts with narrow inline interfaces (`MCPClientLike`, `MCPToolResult`). Client is now typed as `MCPClientLike` instead of `unknown`. Transport uses a structural type. `result.structuredContent` and `result._meta` accessed via `MCPToolResult` interface.

### M-07. No injectable HTTP client for from_openapi ✅ RESOLVED

**File:** `src/from_openapi.ts`

**Resolution:** Added optional `fetch` property to `HTTPServiceConfig`. All three `fetch()` call sites (SSE handler, regular handler, `FromOpenAPIUrl`) now use `config.fetch ?? globalThis.fetch.bind(globalThis)`. Allows custom HTTP clients, proxy injection, and test mocking.

### M-08. No cleanup/disconnect for OpenAPI adapter ✅ RESOLVED

**File:** `src/from_openapi.ts`

**Resolution:** Added `OpenAPIServiceRegistry` class with `add()`, `addFromFile()`, `addFromUrl()`, `get()`, `getAll()`, `remove()`, `registerAll(registry)`, and `size` — mirroring `MCPClientLoader` API pattern. Provides lifecycle management for dynamically added/removed OpenAPI services.

---

## Low (tech debt, nice-to-fix)

### L-01. subscribe() casts handler return as AsyncGenerator without validation ✅ RESOLVED

**Resolution:** Added validation in `registry.registerHandler()` and `registry.register()` that checks if SUBSCRIPTION operations have async generator handlers (using `Object.prototype.toString.call()`). Also added runtime check in `subscribe()` that verifies the handler result is an async iterable before the `for await` loop, throwing a clear `CallError` if not.

### L-02. isResponseEnvelope type guard is lenient ✅ RESOLVED

**Resolution:** Added source-specific validation: `local` checks `operationId` (string) and `timestamp` (number); `http` checks `statusCode` (number); `mcp` checks `isError` (boolean) and `content` (array). Prevents malformed envelopes from passing through.

### L-03. from_schema.ts FromSchema returns Type.Unknown for unrecognized input ✅ RESOLVED

**Resolution:** Added `logger.warn()` call when the fallback `Type.Unknown()` is reached, logging the unrecognized schema via `JSON.stringify()`. Uses `@logtape/logtape` with category `"operations:from_schema"`, matching the existing pattern.

### L-04. from_openapi.ts SSE handler now forwards requestBody ✅ RESOLVED

**File:** `src/from_openapi.ts`

**Resolution:** The SSE subscription handler previously had an empty `else if (key === "body")` branch that silently dropped body parameters. Fixed by adding `body` variable extraction and forwarding it as a JSON request body (with `Content-Type: application/json` header) when present. This correctly supports SSE-over-POST patterns while preserving GET-without-body behavior for standard SSE endpoints.

### L-05. No convenience registerAll methods on MCP or OpenAPI adapters ✅ RESOLVED

**Resolution:** Added `registerAll(registry)` method to `MCPClientLoader`. Added `OpenAPIServiceRegistry` class (M-08) with `registerAll(registry)`, `add()`, `addFromFile()`, `addFromUrl()`, `get()`, `getAll()`, `remove()`, and `size`.