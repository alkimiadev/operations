---
status: draft
last_updated: 2026-04-30
---

# API Surface

All public types, registry, call protocol, subscribe, env, validation, and adapters. See [call-protocol.md](call-protocol.md) for detailed call protocol semantics and [adapters.md](adapters.md) for adapter internals.

## Core Types

### `OperationType`

```ts
enum OperationType {
  QUERY = "query",
  MUTATION = "mutation",
  SUBSCRIPTION = "subscription",
}
```

- `QUERY` — read-only, no side effects
- `MUTATION` — write, has side effects
- `SUBSCRIPTION` — async generator, yields multiple values over time

### `Identity`

```ts
interface Identity {
  id: string
  scopes: string[]
  resources?: Record<string, string[]>
}
```

Caller security context. `scopes` are global permissions (AND-checked against `requiredScopes`). `resources` maps `"type:id"` to action arrays (checked against `resourceType`/`resourceAction`). Derived from keypal `ApiKeyMetadata`.

### `AccessControl`

```ts
type AccessControl = Static<typeof AccessControlSchema>

const AccessControlSchema = Type.Object({
  requiredScopes: Type.Array(Type.String()),
  requiredScopesAny: Type.Optional(Type.Array(Type.String())),
  resourceType: Type.Optional(Type.String()),
  resourceAction: Type.Optional(Type.String()),
  customAuth: Type.Optional(Type.String()),
})
```

| Field | Semantics |
|-------|-----------|
| `requiredScopes` | AND — caller must have ALL listed scopes |
| `requiredScopesAny` | OR — caller must have at least ONE listed scope |
| `resourceType` | Resource category for resource-scoped checks |
| `resourceAction` | Required action on the resource |
| `customAuth` | Name of custom auth function (not yet enforced) |

### `ErrorDefinition`

```ts
type ErrorDefinition = Static<typeof ErrorDefinitionSchema>

const ErrorDefinitionSchema = Type.Object({
  code: Type.String(),
  description: Type.String(),
  schema: Type.Unknown(),
  httpStatus: Type.Optional(Type.Number()),
})
```

Declared on `IOperationDefinition.errorSchemas`. Contract between operation and callers about what errors it may produce.

### `OperationContext`

```ts
type OperationContext = Static<typeof OperationContextSchema> & {
  env?: OperationEnv
  stream?: () => AsyncIterable<unknown>
  pubsub?: unknown
}
```

Passed to every handler. `env` provides namespace-keyed access to other operations (via `buildEnv`). `stream` and `pubsub` support subscription and event patterns.

### `OperationSpec`

```ts
interface OperationSpec<TInput = unknown, TOutput = unknown> {
  name: string
  namespace: string
  version: string
  type: OperationType
  title?: string
  description: string
  tags?: string[]
  inputSchema: TSchema
  outputSchema: TSchema
  errorSchemas?: ErrorDefinition[]
  accessControl: AccessControl
  _meta?: Record<string, unknown>
}
```

Serializable, hashable subset of an operation definition. No handler — safe to send over the wire.

### `IOperationDefinition`

```ts
interface IOperationDefinition<TInput, TOutput, TContext> extends OperationSpec<TInput, TOutput> {
  handler: OperationHandler<TInput, TOutput, TContext> | SubscriptionHandler<TInput, TOutput, TContext>
}
```

Full definition including the runtime handler. Registered with `OperationRegistry`.

### `OperationHandler` / `SubscriptionHandler`

```ts
type OperationHandler<TInput, TOutput, TContext> = (
  input: TInput, context: TContext,
) => Promise<TOutput> | TOutput

type SubscriptionHandler<TInput, TOutput, TContext> = (
  input: TInput, context: TContext,
) => AsyncGenerator<TOutput, void, unknown>
```

`OperationHandler` returns a single value. `SubscriptionHandler` yields values over time.

### `OperationEnv`

```ts
type OperationEnv = Record<string, Record<string, (input: unknown) => Promise<unknown>>>
```

Namespace-keyed operation map. Accessed as `env.namespace.operationName(input)`. Created by `buildEnv`.

## Registry

### `OperationRegistry`

| Method | Signature | Description |
|--------|-----------|-------------|
| `register(operation)` | `(operation: IOperationDefinition) => void` | Register by `{namespace}.{name}` key. Validates schemas. |
| `registerAll(operations)` | `(operations: IOperationDefinition[]) => void` | Bulk register. |
| `get(id)` | `(id: string) => IOperationDefinition \| undefined` | Get by full id (`"namespace.name"`). |
| `getByName(namespace, name)` | `(namespace: string, name: string) => IOperationDefinition \| undefined` | Get by parts. |
| `list()` | `() => IOperationDefinition[]` | All registered operations. |
| `getSpec(id)` | `(id: string) => OperationSpec \| undefined` | Serializable spec (no handler). |
| `getAllSpecs()` | `() => OperationSpec[]` | All serializable specs. |
| `execute(operationId, input, context)` | `(id: string, input: TInput, ctx: OperationContext) => Promise<TOutput>` | Validate input, run handler, warn on output mismatch. Throws if not found or validation fails. |

Registration key format: `{namespace}.{name}`. Overwrite on duplicate.

`execute` validates input with `validateOrThrow` before calling the handler. Output validation uses `collectErrors` and logs warnings — it does not throw.

## Call Protocol

### `PendingRequestMap`

See [call-protocol.md](call-protocol.md) for full semantics.

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor(eventTarget?)` | `(eventTarget?: EventTarget)` | Creates internal pubsub, wires subscription handlers for responded/error/aborted. |
| `call(operationId, input, options?)` | `Promise<unknown>` | Publish `call.requested`, return Promise that resolves on `call.responded`. |
| `respond(requestId, output)` | `void` | Publish `call.responded`. |
| `emitError(requestId, code, message, details?)` | `void` | Publish `call.error`. |
| `abort(requestId)` | `void` | Publish `call.aborted`, reject pending Promise. |
| `getPendingCount()` | `number` | Number of in-flight requests. |

### `CallHandler`

```ts
type CallHandler = (event: CallRequestedEvent) => Promise<void>
```

Created by `buildCallHandler({ registry, eventTarget? })`. Subscribes to `call.requested`, checks access control, validates input, executes via registry. On success: no-op (handler is expected to publish `call.responded` through the PendingRequestMap). On failure: throws `CallError`.

### `CallEventMap`

```ts
const CallEventMap = {
  "call.requested": Type.Object({ ... }),
  "call.responded": Type.Object({ ... }),
  "call.aborted": Type.Object({ ... }),
  "call.error": Type.Object({ ... }),
}
```

Typed event map compatible with `@alkdev/pubsub`. See [call-protocol.md](call-protocol.md) for event shapes.

### Event Types

| Type | Fields | Description |
|------|--------|-------------|
| `CallRequestedEvent` | `requestId, operationId, input, parentRequestId?, deadline?, identity?` | Initiates a call |
| `CallRespondedEvent` | `requestId, output` | Successful response |
| `CallAbortedEvent` | `requestId` | Call cancelled |
| `CallErrorEvent` | `requestId, code, message, details?` | Error response |

## Subscribe

### `subscribe`

```ts
function subscribe(
  registry: OperationRegistry,
  operationId: string,
  input: unknown,
  context: OperationContext,
): AsyncGenerator<unknown, void, unknown>
```

Direct subscription execution. Gets the operation, casts its handler to `AsyncGenerator`, yields each value. Properly cleans up the generator on iteration stop (calls `generator.return()` in `finally`).

This is the synchronous alternative to the call protocol's `call.requested` → `call.responded` flow for subscriptions. Use `subscribe()` for in-process subscription consumption; use `PendingRequestMap` for cross-transport subscription.

## Env Builder

### `buildEnv`

```ts
function buildEnv(options: EnvOptions): OperationEnv

interface EnvOptions {
  registry: OperationRegistry
  context: OperationContext
  allowedNamespaces?: string[]
  callMap?: PendingRequestMap
}
```

Creates a namespace-keyed `OperationEnv` for nested operation calls. Two modes:

- **Direct mode**: `buildEnv({ registry, context })` — env functions call `registry.execute()`
- **Call protocol mode**: `buildEnv({ registry, context, callMap })` — env functions call `callMap.call()`, publishing `call.requested` events with `parentRequestId` for call graph tracking

`SUBSCRIPTION` operations are filtered out — env only provides QUERY and MUTATION operations for nested calls.

`allowedNamespaces` restricts which namespaces are available.

## Validation

| Export | Signature | Description |
|--------|-----------|-------------|
| `assertIsSchema(schema, context?)` | `(unknown, string?) => void` | Throws if `schema` is not a valid TypeBox schema. |
| `validateOrThrow(schema, value, context?)` | `(TSchema, unknown, string?) => void` | Throws with formatted errors if value fails schema check. |
| `collectErrors(schema, value)` | `(TSchema, unknown) => Array<{path, message}>` | Returns errors array (empty if valid). |
| `formatValueErrors(errors, indent?)` | `(Iterable<{path, message}>, string?) => string` | Human-readable error formatting. |

## Error Model

### `CallError`

```ts
class CallError extends Error {
  readonly code: CallErrorCode
  readonly details?: unknown
  constructor(code: CallErrorCode, message: string, details?: unknown)
}
```

### `InfrastructureErrorCode`

```ts
enum InfrastructureErrorCode {
  OPERATION_NOT_FOUND = "OPERATION_NOT_FOUND",
  ACCESS_DENIED = "ACCESS_DENIED",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  TIMEOUT = "TIMEOUT",
  ABORTED = "ABORTED",
  EXECUTION_ERROR = "EXECUTION_ERROR",
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}
```

`CallErrorCode` is `InfrastructureErrorCode | string` — domain codes from `errorSchemas` are plain strings.

### `mapError`

```ts
function mapError(error: unknown, errorSchemas?: { code: string; schema: unknown }[]): CallError
```

Converts any thrown value to `CallError`. If the thrown value is already a `CallError`, returns it. If it's an `Error` and `errorSchemas` are provided, matches against declared error codes. Falls back to `EXECUTION_ERROR` for unmatched `Error` instances and `UNKNOWN_ERROR` for non-Error values.

## Schema Conversion

### `FromSchema`

```ts
function FromSchema<T>(T: T): TSchema
```

Converts JSON Schema to TypeBox `TSchema`. Handles: `allOf`, `anyOf`, `oneOf`, `enum`, `object` (with `required` tracking), `tuple`, `array`, `const`, `$ref`, primitives (`string`, `number`, `integer`, `boolean`, `null`). Unknown shapes fall back to `Type.Unknown()`.

Used internally by `FromOpenAPI` to convert OpenAPI JSON Schema definitions to TypeBox. Also used by `from_mcp` to convert MCP tool `inputSchema` (which is JSON Schema).

## Adapters

See [adapters.md](adapters.md) for detailed adapter documentation.

| Adapter | Import | Description |
|---------|--------|-------------|
| `FromOpenAPI` | Main barrel | OpenAPI spec → `IOperationDefinition[]` |
| `FromOpenAPIFile` | Main barrel | OpenAPI file → `IOperationDefinition[]` |
| `FromOpenAPIUrl` | Main barrel | OpenAPI URL → `IOperationDefinition[]` |
| `createMCPClient` | `from-mcp` sub-path | MCP server → `MCPClientWrapper` with tool operations |
| `closeMCPClient` | `from-mcp` sub-path | Close MCP client connection |
| `MCPClientLoader` | `from-mcp` sub-path | Manage multiple MCP servers |
| `scanOperations` | Main barrel | Filesystem auto-discovery of operation definitions |