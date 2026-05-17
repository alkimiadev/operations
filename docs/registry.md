# Registry

The `OperationRegistry` is the central store for operation specs and handlers. It handles registration, validation, access control enforcement, and execution.

## Operation Types

```ts
enum OperationType {
  QUERY = "query",
  MUTATION = "mutation",
  SUBSCRIPTION = "subscription",
}
```

- **Query** — read-only, no side effects
- **Mutation** — writes state, side effects
- **Subscription** — streams results over time (async generator handler)

## Defining an Operation

Every operation has a **spec** (serializable metadata) and optionally a **handler** (the function that runs).

```ts
import { Type } from "@alkdev/typebox";
import { OperationType } from "@alkdev/operations";

const createTask = {
  name: "create",
  namespace: "task",
  version: "1.0.0",
  type: OperationType.MUTATION,
  description: "Create a new task",
  inputSchema: Type.Object({
    title: Type.String(),
    priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("high")])),
  }),
  outputSchema: Type.Object({
    id: Type.String(),
    title: Type.String(),
  }),
  accessControl: {
    requiredScopes: ["task:write"],
  },
  handler: async (input: { title: string; priority?: string }) => {
    return { id: crypto.randomUUID(), title: input.title };
  },
};
```

### Spec Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Operation name within its namespace |
| `namespace` | `string` | yes | Grouping (e.g. `"task"`, `"user"`) |
| `version` | `string` | yes | Semantic version |
| `type` | `OperationType` | yes | `query`, `mutation`, or `subscription` |
| `description` | `string` | yes | Human-readable description |
| `inputSchema` | `TSchema` | yes | TypeBox schema for input validation |
| `outputSchema` | `TSchema` | yes | TypeBox schema for output; use `Type.Unknown()` if untyped |
| `accessControl` | `AccessControl` | yes | Scopes and resource requirements (see [Access Control](access-control.md)) |
| `title` | `string` | no | Human-readable title |
| `tags` | `string[]` | no | Tags for filtering/grouping |
| `errorSchemas` | `ErrorDefinition[]` | no | Declared error codes and their schemas |
| `_meta` | `Record<string, unknown>` | no | Arbitrary metadata |

### Handler Signature

**Query/Mutation** handlers return a value (or `ResponseEnvelope`):

```ts
type OperationHandler<TInput, TOutput> = (
  input: TInput,
  context: OperationContext,
) => Promise<TOutput> | TOutput;
```

**Subscription** handlers must be async generators:

```ts
type SubscriptionHandler<TInput, TOutput> = (
  input: TInput,
  context: OperationContext,
) => AsyncGenerator<TOutput, void, unknown>;
```

## Registering Operations

### Combined registration

```ts
const registry = new OperationRegistry();
registry.register(createTask);
```

`register()` stores both the spec and the handler. The `handler` field is optional — you can register the spec first and add the handler later.

### Batch registration

```ts
registry.registerAll([createTask, listTasks, deleteTask]);
```

### Separate spec and handler

```ts
registry.registerSpec(mySpec);
registry.registerHandler("task.create", myHandler);
```

This is useful when specs come from one source (e.g., OpenAPI import) and handlers from another.

> `registerHandler` throws if no spec exists for the operation ID.

## Executing Operations

```ts
const envelope = await registry.execute(
  "task.create",
  { title: "Ship it" },
  { identity: { id: "user-1", scopes: ["task:write"] } },
);
```

What `execute()` does:

1. Looks up the spec by `namespace.name`
2. Looks up the handler
3. **Enforces access control** (unless `context.trusted` is `true`)
4. **Validates input** against the spec's `inputSchema`
5. Runs the handler
6. **Wraps the result** in a `ResponseEnvelope` if not already one
7. **Casts the output** through `outputSchema` and warns on validation errors

Returns `ResponseEnvelope<TOutput>`. See [Response Envelopes](response-envelopes.md).

### Execution context

```ts
interface OperationContext {
  requestId?: string;
  parentRequestId?: string;
  identity?: Identity;
  trusted?: boolean;       // set by buildEnv, not by callers
  metadata?: Record<string, unknown>;
  env?: OperationEnv;       // injected by buildEnv for inter-op calls
}
```

## Querying the Registry

```ts
registry.get("task.create");        // spec + handler, or undefined
registry.getSpec("task.create");    // spec only
registry.getHandler("task.create"); // handler only
registry.getByName("task", "create"); // same as get("task.create")
registry.list();                    // all specs + handlers
registry.getAllSpecs();              // all specs only
```

## Schema Adapters

By default, the registry expects TypeBox schemas. If you use Zod or Valibot, pass a schema adapter:

```ts
import { zodAdapter } from "@alkdev/operations/from-typemap";

const adapter = zodAdapter();
await adapter.init();

const registry = new OperationRegistry({ schemaAdapter: adapter });
```

See [Adapters](adapters.md) for details.