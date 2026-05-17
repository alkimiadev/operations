# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-05-17

### Added

- `OperationRegistry` with `register`, `registerAll`, `registerSpec`, `registerHandler`, `execute`, `get`, `getSpec`, `getHandler`, `list`, `getAllSpecs`
- `OperationType` enum: `QUERY`, `MUTATION`, `SUBSCRIPTION`
- `OperationSpec`, `OperationContext`, `Identity`, `AccessControl`, `ErrorDefinition` types
- `PendingRequestMap` with `call`, `subscribe`, `respond`, `emitError`, `complete`, `abort`
- `buildCallHandler` wiring call protocol to registry
- `subscribe()` for direct async generator execution of subscription operations
- `buildEnv()` for inter-operation composition with trusted context
- `ResponseEnvelope` with `localEnvelope`, `httpEnvelope`, `mcpEnvelope`, `unwrap`, `isResponseEnvelope`
- `CallError`, `InfrastructureErrorCode`, `mapError` for structured error handling
- `checkAccess`, `enforceAccess` for scope and resource-based authorization
- `FromSchema` — JSON Schema to TypeBox conversion
- `FromOpenAPI`, `FromOpenAPIFile`, `FromOpenAPIUrl`, `OpenAPIServiceRegistry` — OpenAPI adapter with SSE subscription support
- `createMCPClient`, `closeMCPClient`, `MCPClientLoader` — MCP adapter
- `defaultAdapter`, `zodAdapter`, `valibotAdapter` — SchemaAdapter system for Zod/Valibot schemas
- `scanOperations` — filesystem-based operation discovery with injectable `ScannerFS`
- `validateOrThrow`, `collectErrors`, `assertIsSchema`, `formatValueErrors` — validation helpers
- Sub-path exports: `@alkdev/operations/from-mcp`, `@alkdev/operations/from-openapi`, `@alkdev/operations/from-typemap`
- Dual ESM + CJS output via tsup
- 300 tests across 11 test files

[0.1.0]: https://git.alk.dev/alkdev/operations/releases/tag/v0.1.0