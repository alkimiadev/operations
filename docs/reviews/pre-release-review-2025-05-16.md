# Pre-Release Review: @alkdev/operations

**Date:** 2026-05-16
**Scope:** Full codebase review for issues that would impact downstream hub/spoke implementations
**Status:** C-01 through C-05 and H-01 through H-06 resolved. M-01 through M-08 and L-01 through L-05 remain as follow-ups.

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

### M-01. Duplicate OperationDefinitionSchema vs OperationSpecSchema

**File:** `src/types.ts:83-101` vs `121-138`

These two schemas are nearly identical, differing only in the `handler` field. Any field added to one must be added to the other. They should be composed (e.g., OperationDefinitionSchema extends OperationSpecSchema + handler).

### M-02. No subpath export for from_openapi

**File:** `package.json` exports only `./from-mcp` and `./from-typemap` as subpath entries. `from_openapi.ts` is bundled into the main entry, meaning anyone importing `PendingRequestMap` or `OperationRegistry` also pulls in the OpenAPI adapter code (including `fetch` usage and `node:fs/promises` import). This should be a separate subpath export for tree-shaking.

### M-03. Subscription deadline semantics are ambiguous

**File:** `src/call.ts:103-109`

When a `call.responded` event arrives for a subscription, the deadline timer is reset to the same `entry.state.deadline` value. If `deadline` is an absolute timestamp (e.g., `Date.now() + 5000`), the new timer delay would be `deadline - Date.now()`, which shrinks over time and could become negative. The documentation doesn't specify whether `deadline` is absolute or relative. This should be clarified and the reset logic adjusted.

### M-04. No unsubscribe/completion signaling in call protocol

**File:** `src/call.ts:298-301`

When a subscription ends (the `for await` loop completes), `buildCallHandler` simply stops calling `callMap.respond()`. There is no `call.completed` or `call.finished` event type to explicitly signal subscription completion. The consumer must detect iterator completion, which works with `Repeater` but may not work with all pubsub implementations.

### M-05. mapError uses fragile message.includes(code) matching

**File:** `src/error.ts:37-41`

Error matching against `errorSchemas` uses `message.includes(schema.code)`, which can match incorrectly (e.g., `"ITEM_NOT_FOUND"` matches `NOT_FOUND`). Should use exact prefix/suffix matching or a structured error code protocol.

### M-06. from_mcp.ts uses multiple `any` casts

**File:** `src/from_mcp.ts:91, 115, 137, 155-156, 173`

Five `any` casts in the MCP adapter. If the MCP SDK types change, these will silently break at runtime. Should use narrow type assertions or import the actual SDK types.

### M-07. No injectable HTTP client for from_openapi

**File:** `src/from_openapi.ts:354, 444, 527`

All HTTP operations use the global `fetch()` API with no way to inject a custom HTTP client. Hub/spoke implementations running in constrained environments (custom proxy, no direct network, test mocking) cannot override the transport. Should accept an optional `fetch` parameter in `HTTPServiceConfig`.

### M-08. No cleanup/disconnect for OpenAPI adapter

Unlike `MCPClientLoader.closeAll()`, there is no cleanup path for OpenAPI HTTP connections. Long-running hub processes that dynamically add/remove OpenAPI services may leak resources.

---

## Low (tech debt, nice-to-fix)

### L-01. subscribe() casts handler return as AsyncGenerator without validation

**File:** `src/subscribe.ts:53`

`handler(input, context) as AsyncGenerator` bypasses runtime type checking. If someone registers a regular async function (not a generator) for a SUBSCRIPTION operation, this fails at iteration time with a confusing error. Should validate at registration time that subscription operations have a `SubscriptionHandler`.

### L-02. isResponseEnvelope type guard is lenient

**File:** `src/response-envelope.ts:132-138`

Checks for `data` and `meta.source` but doesn't validate `meta.operationId`, `meta.timestamp`, or the structure of `data`. A hub checking `isResponseEnvelope()` could pass malformed data through.

### L-03. from_schema.ts FromSchema returns Type.Unknown for unrecognized input

**File:** `src/from_schema.ts:114`

An empty object `{}` silently becomes `Type.Unknown({})`, which validates anything. Should at minimum log a warning.

### L-04. from_openapi.ts SSE GET includes requestBody handling

**File:** `src/from_openapi.ts:329, 341`

GET-based SSE subscriptions include body parameter handling, which is unusual for SSE. This is noted in a comment but not addressed.

### L-05. No convenience registerAll methods on MCP or OpenAPI adapters

`MCPClientLoader` has `getAllOperations()` but no `registerAll(registry)`. `FromOpenAPI` returns a plain array with no helper. Consumers must iterate manually. Minor ergonomics issue.