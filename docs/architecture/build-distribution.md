---
status: draft
last_updated: 2026-05-11
---

# Build & Distribution

Dependencies, project structure, sub-path exports, peer deps, and build tooling.

## Dependencies

### Runtime

| Package | Purpose |
|---------|---------|
| `@alkdev/typebox` | Schema system. `Type` for building schemas, `Value` for validation, `KindGuard` for schema assertion. |
| `@alkdev/pubsub` | Call protocol transport. `PendingRequestMap` creates an internal `PubSub` for event routing. Uses `subscribe(type, id)` and `publish(type, id, payload)` API with `EventEnvelope` wrapping. |
| `@logtape/logtape` | Structured logging. Direct import, no wrapper. See [ADR-001](decisions/001-logger-direct-import.md). |

### Peer (Optional)

| Package | Required By | Purpose |
|---------|-------------|---------|
| `@modelcontextprotocol/sdk` | `from_mcp` sub-path | MCP client transport (stdio, HTTP). Dynamic import — only loaded when `createMCPClient` is called. |

### Dev

| Package | Purpose |
|---------|---------|
| `tsup` | Build tool. Dual ESM + CJS with declarations. |
| `typescript` | Type checking (`tsc --noEmit` for lint). |
| `vitest` | Test runner. |
| `@vitest/coverage-v8` | V8 coverage provider. |
| `@modelcontextprotocol/sdk` | Dev dep for MCP tests. Also listed as optional peer. |
| `@types/node` | Node.js type definitions. |

## Project Structure

```
@alkdev/operations/
  src/
    index.ts            # Barrel: re-exports all public API
    types.ts            # Core types: IOperationDefinition, OperationSpec, OperationType, etc.
    registry.ts         # OperationRegistry: registerSpec, registerHandler, execute, get, list
    validation.ts       # assertIsSchema, validateOrThrow, collectErrors, formatValueErrors
    response-envelope.ts # ResponseEnvelope types, factories, detection, schemas, unwrap
    call.ts             # PendingRequestMap, buildCallHandler, CallEventMap, event types
    subscribe.ts        # subscribe(): direct AsyncGenerator execution
    env.ts              # buildEnv(): namespace-keyed env with direct/call-protocol modes
    error.ts            # CallError, InfrastructureErrorCode, mapError
    from_schema.ts      # FromSchema: JSON Schema → TypeBox conversion
    from_openapi.ts     # FromOpenAPI, FromOpenAPIFile, FromOpenAPIUrl
    from_mcp.ts         # createMCPClient, closeMCPClient, MCPClientLoader
    scanner.ts          # scanOperations: filesystem auto-discovery
  test/
    # Unit tests per module
  docs/
    architecture.md
    architecture/
      README.md
      api-surface.md
      call-protocol.md
      adapters.md
      build-distribution.md
      decisions/
  package.json
  tsconfig.json
  tsup.config.ts
  vitest.config.ts
```

## Sub-Path Exports

```json
{
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    },
    "./from-mcp": {
      "import": { "types": "./dist/from-mcp.d.ts", "default": "./dist/from-mcp.js" },
      "require": { "types": "./dist/from-mcp.d.cts", "default": "./dist/from-mcp.cjs" }
    }
  }
}
```

The `./from-mcp` sub-path isolates the MCP SDK peer dependency. Consumers that don't use MCP don't need to install `@modelcontextprotocol/sdk`. See [ADR-003](decisions/003-peer-dep-adapters.md).

The main barrel (`src/index.ts`) re-exports everything including `createMCPClient` and `MCPClientLoader` for convenience. The sub-path exists for explicit dependency isolation, not for excluding from the barrel.

## Build

- **Tool**: `tsup` — produces dual ESM + CJS with declarations
- **Entry points**: `src/index.ts`, `src/from_mcp.ts`
- **Format**: ESM + CJS
- **Target**: `es2022`
- **Splitting**: enabled

```ts
// tsup.config.ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/from_mcp.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  target: 'es2022',
})
```

## Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `build` | `tsup` | Build ESM + CJS + declarations |
| `lint` | `tsc --noEmit` | Type-check only (no emit) |
| `test` | `vitest run` | Run tests |
| `test:watch` | `vitest` | Watch mode |
| `test:coverage` | `vitest run --coverage` | Coverage report (v8) |

## Testing

- **Runner**: `vitest`
- **Coverage**: `@vitest/coverage-v8`
- **Config**: `vitest.config.ts`

Tests should mock external services (MCP servers, HTTP endpoints) and use injectable FS interfaces (`ScannerFS`, `OpenAPIFS`) rather than real filesystem access.

## Targets

- **Publish**: npm (`@alkdev/operations`)
- **Runtime**: Node 18+, Deno, Bun — pure JS except `from_mcp` which requires `@modelcontextprotocol/sdk`
- **Deno compatibility**: Source is standard TypeScript with no Deno-specific APIs. Runtime-agnostic FS injection means Deno can provide its own `ScannerFS` and `OpenAPIFS` implementations