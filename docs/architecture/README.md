---
status: draft
last_updated: 2026-05-11
---

# @alkdev/operations Architecture

Typed operations registry, call protocol, and adapters (MCP, OpenAPI). Everything is an operation with TypeBox schemas, access control metadata, and a handler. The call protocol provides unified event-based invocation that works the same whether local, remote, or streamed.

## Why This Exists

Extracted from `@alkdev/alkhub_ts/packages/core/operations/` and `packages/core/mcp/`. The operations system was already self-contained within alkhub, depending only on `@alkdev/typebox` and `@alkdev/pubsub`. Extracting into a standalone package:

1. **Reduces coupling** — alkhub depends on operations, not the other way around
2. **Enables reuse** — multiple alkhub packages and external consumers can share the same operations registry and call protocol
3. **Isolates peer deps** — MCP SDK and other heavy dependencies are optional; consumers that don't need them shouldn't carry them
4. **Standalone utility** — the call protocol, validation, and schema conversion are useful outside alkhub (e.g., opencode OpenAPI import)

## Core Principle

**The spec is the contract; the handler is the runtime.** Every API endpoint, agent action, coordination tool, and MCP tool has an `OperationSpec` (serializable, hashable descriptor) and optionally a handler function. The registry stores specs and handlers separately — they can be registered together with `register()` or independently with `registerSpec()` and `registerHandler()`. The call protocol routes invocations through specs. Adapters generate specs (and handlers) from external definitions.

All paths funnel into the same registry:

```
Hub HTTP API routes  → registry.execute("namespace.operation", input, ctx)
MCP server tools     → registry.execute(...)
FromOpenAPI ops      → fetch(remote REST API)
MCP client tools     → MCPClientLoader → registry.execute(...)
Agent session LLM    → tool calls with JSON Schema → registry.execute(...)
```

Access control, validation, and error handling are consistent regardless of entry point.

## What This Package Provides

- **Core types** — `OperationSpec`, `IOperationDefinition`, `OperationType`, `AccessControl`, `Identity`, `OperationContext`, `OperationHandler`, `SubscriptionHandler`
- **Registry** — `OperationRegistry` with `register`, `registerSpec`, `registerHandler`, `execute`, `getSpec`, `getHandler`, spec extraction
- **Call protocol** — `PendingRequestMap`, `CallHandler`, `call≡subscribe` event semantics
- **Subscribe** — `subscribe()` for `AsyncGenerator`-based subscription operations
- **Env builder** — `buildEnv()` for nested operation calls (direct or call protocol mode)
- **Validation** — `assertIsSchema`, `validateOrThrow`, `collectErrors`, `formatValueErrors`
- **Error model** — `CallError`, `InfrastructureErrorCode`, `mapError`
- **Schema conversion** — `FromSchema` converts JSON Schema to TypeBox
- **Adapters**:
  - `FromOpenAPI` / `FromOpenAPIFile` / `FromOpenAPIUrl` — OpenAPI spec to operations
  - `createMCPClient` / `MCPClientLoader` — MCP server tools to operations (peer dep: `@modelcontextprotocol/sdk`)
  - `scanOperations` — filesystem auto-discovery of operation definitions

## Consumer Context

### alkhub (hub-spoke coordinator)

The hub uses the operations registry as the single execution engine for all work. Operations are registered from multiple sources (local definitions, OpenAPI imports, MCP tool connections). The call protocol routes invocations through `PendingRequestMap` for call graph tracking, abort cascading, and structured error handling.

### opencode (agent tool use)

`FromOpenAPI` generates typed operation definitions from any OpenAPI spec. This provides an instant typed client without hand-writing handlers. MCP tool connections are managed through `MCPClientLoader`.

### Spoke SDK (future)

Spokes will import `@alkdev/operation` for operation definitions and `@alkdev/pubsub` for the call protocol event transport. The `buildEnv` call protocol mode connects nested operations through `PendingRequestMap`.

## Threat Model

- **Schema trust** — `FromSchema` converts arbitrary JSON Schema to TypeBox. Malformed or deeply nested schemas could cause excessive CPU or memory. Input validation (`validateOrThrow`) runs before handler execution, but the schemas themselves are trusted.
- **Handler trust** — operation handlers are arbitrary async functions. The registry runs them in the same process. No sandboxing.
- **Peer dep isolation** — `@modelcontextprotocol/sdk` is an optional peer dependency. Consumers that don't use `from_mcp` don't install it. The sub-path export `@alkdev/operations/from-mcp` makes this explicit.
- **Access control enforcement** — `CallHandler` checks `AccessControl` before dispatch. Direct `registry.execute()` calls bypass access control by design (internal trusted calls). Untrusted callers must use the call protocol.

## Architecture Documents

| Document | Content |
|----------|---------|
| [api-surface.md](api-surface.md) | All public types, registry, call protocol, subscribe, env, adapters |
| [call-protocol.md](call-protocol.md) | PendingRequestMap, CallHandler, call≡subscribe, events, error model, access control |
| [response-envelopes.md](response-envelopes.md) | Response envelope types, factory functions, detection, schemas, integration points |
| [adapters.md](adapters.md) | from_schema, from_openapi, from_mcp, scanner — how they work, how to add new adapters |
| [build-distribution.md](build-distribution.md) | Dependencies, project structure, sub-path exports, peer deps, build tooling |

## Document Lifecycle

Architecture documents use YAML frontmatter with `status` and `last_updated` fields:

```yaml
---
status: draft | stable | deprecated
last_updated: YYYY-MM-DD
---
```

| Status | Meaning | Transitions |
|--------|---------|-------------|
| `draft` | Under active development. Content may change. | → `stable` when implementation is complete and tests verify API contract. |
| `stable` | API contracts are locked. Changes require review cycle. | → `deprecated` when superseded. |
| `deprecated` | Superseded. Kept for reference. | Removed when no longer referenced. |

## References

- Source: `src/` in this package
- Provenance: `@alkdev/alkhub_ts/packages/core/operations/` and `packages/core/mcp/`
- Related: `@alkdev/pubsub` (call protocol transport), `@alkdev/typebox` (schema system)
- alkhub operations doc: `@alkdev/alkhub_ts/docs/architecture/operations.md`
- alkhub call protocol doc: `@alkdev/alkhub_ts/docs/architecture/call-graph.md`