# @alkdev/operations

Typed operations registry, call protocol, and adapters (MCP, OpenAPI).

Every API endpoint, agent action, and tool is an **operation** with a TypeBox schema, access control metadata, and a handler. The registry stores specs and handlers independently. The call protocol provides unified event-based invocation — `call` and `subscribe` use the same events, same `PendingRequestMap`. Adapters generate operations from OpenAPI specs, MCP servers, and filesystem manifests.

## Install

```bash
npm install @alkdev/operations
```

Optional peer dependencies (only if you need them):

```bash
npm install @alkdev/typemap       # for Zod/Valibot schema adapters
npm install @modelcontextprotocol/sdk  # for MCP client integration
```

## Quick Start

```ts
import { Type } from "@alkdev/typebox";
import { OperationRegistry, OperationType } from "@alkdev/operations";

const registry = new OperationRegistry();

registry.register({
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
  accessControl: { requiredScopes: ["task:write"] },
  handler: async (input) => {
    return { id: crypto.randomUUID(), title: input.title };
  },
});

const result = await registry.execute(
  "task.create",
  { title: "Ship it", priority: "high" },
  { identity: { id: "user-1", scopes: ["task:write"] } },
);

console.log(result.data);
```

## Core Concepts

- **OperationSpec** — serializable descriptor: name, namespace, type, schemas, access control
- **OperationHandler** — the function that runs when the operation is called
- **OperationRegistry** — register specs and handlers, execute operations, validate I/O
- **PendingRequestMap** — event-based call protocol: `call()`, `respond()`, `emitError()`, `abort()`
- **ResponseEnvelope** — universal result wrapper with transport metadata (`local`, `http`, `mcp`)
- **buildEnv()** — generate a nested call surface for inter-operation composition

## Entry Points

| Import | Purpose |
|--------|---------|
| `@alkdev/operations` | Core: registry, call protocol, envelopes, env, validation, errors, FromSchema |
| `@alkdev/operations/from-mcp` | MCP client integration (requires `@modelcontextprotocol/sdk`) |
| `@alkdev/operations/from-openapi` | OpenAPI integration |
| `@alkdev/operations/from-typemap` | Zod/Valibot schema adapters (requires `@alkdev/typemap`) |

## Guides

| Guide | Topic |
|-------|-------|
| [Registry](docs/registry.md) | Defining, registering, and executing operations |
| [Call Protocol](docs/call-protocol.md) | PendingRequestMap, CallHandler, call/subscribe events |
| [Subscriptions](docs/subscriptions.md) | Real-time streaming with async generators |
| [Response Envelopes](docs/response-envelopes.md) | Universal result wrapper and transport metadata |
| [Access Control](docs/access-control.md) | Scope and resource-based authorization |
| [Composition](docs/env-and-composition.md) | Inter-operation calls with buildEnv |
| [Error Handling](docs/errors.md) | CallError, infrastructure codes, mapError |
| [Adapters](docs/adapters.md) | MCP, OpenAPI, FromSchema, scanner, typemap |
| [Validation](docs/validation.md) | Schema validation helpers |

## API Reference

For detailed type signatures, see [docs/architecture/api-surface.md](docs/architecture/api-surface.md).

## License

MIT OR Apache-2.0