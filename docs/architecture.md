# Architecture

> **This document has been decomposed into modular documents.** See [docs/architecture/](architecture/) for the current architecture specification.

| Document | Content |
|----------|---------|
| [architecture/README.md](architecture/README.md) | Overview, why this exists, what it provides, consumer context, threat model |
| [architecture/api-surface.md](architecture/api-surface.md) | All public types, registry API, call protocol API, subscribe, env, adapters |
| [architecture/call-protocol.md](architecture/call-protocol.md) | PendingRequestMap, CallHandler, call≡subscribe semantics, events, error model, access control |
| [architecture/adapters.md](architecture/adapters.md) | from_schema, from_openapi, from_mcp, scanner — how they work, how to add new adapters |
| [architecture/build-distribution.md](architecture/build-distribution.md) | Dependencies, project structure, sub-path exports, peer deps, build tooling |

### Design Decisions

| ADR | Decision |
|-----|----------|
| [001](architecture/decisions/001-logger-direct-import.md) | Direct @logtape/logtape import instead of wrapper module |
| [002](architecture/decisions/002-fs-injection.md) | Inject filesystem dependencies for runtime agnosticism |
| [003](architecture/decisions/003-peer-dep-adapters.md) | Peer dependencies for adapter isolation (MCP SDK, @std/path) |
| [004](architecture/decisions/004-schema-const-naming.md) | Schema const naming convention (AccessControlSchema + AccessControl type) |