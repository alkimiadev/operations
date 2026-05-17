# Composition (buildEnv)

Operations often need to call other operations. `buildEnv()` generates an `OperationEnv` — a nested record of namespace → operation name → caller — that lets handlers invoke other operations without knowing the registry.

## Creating an Environment

```ts
import { buildEnv } from "@alkdev/operations";

const env = buildEnv({
  registry,
  context: { identity: { id: "user-1", scopes: ["task:read"] } },
  allowedNamespaces: ["task", "user"],
});
```

This walks all non-subscription specs in the registry and creates a callable function for each one.

### Result Shape

```ts
// env mirrors the registry's namespace.name structure:
env.task.create({ title: "New task" });    // Promise<ResponseEnvelope>
env.task.list({ filter: "active" });        // Promise<ResponseEnvelope>
env.user.get({ id: "user-1" });            // Promise<ResponseEnvelope>
```

Each function calls `registry.execute()` under the hood.

## Trusted Calls

All calls made through `buildEnv()` set `trusted: true` on the context. This means:

- Access control checks are **skipped**
- The caller's identity propagates, but scopes are not enforced
- Input/output validation still runs

This is intentional — internal composition shouldn't require every internal operation to have every scope. Access control is enforced at the boundary (the call protocol), not between internal operations.

## Usage in Handlers

```ts
const createAndNotify = {
  name: "createAndNotify",
  namespace: "task",
  version: "1.0.0",
  type: OperationType.MUTATION,
  description: "Create a task and send a notification",
  inputSchema: Type.Object({ title: Type.String(), assignee: Type.String() }),
  outputSchema: Type.Object({ taskId: Type.String(), notified: Type.Boolean() }),
  accessControl: { requiredScopes: ["task:write"] },
  handler: async (input, context) => {
    const task = await context.env!.task.create(input);
    await context.env!.notification.send({ userId: input.assignee, message: "New task" });
    return { taskId: task.data.id, notified: true };
  },
};
```

## Options

| Option | Type | Description |
|--------|------|-------------|
| `registry` | `OperationRegistry` | Required. The registry to build from. |
| `context` | `OperationContext` | Required. Base context (identity, metadata, etc.) |
| `allowedNamespaces` | `string[]` | Optional. Only include operations from these namespaces. |

Subscriptions are excluded from the env (they can't be awaited). Use `subscribe()` directly for subscription composition.