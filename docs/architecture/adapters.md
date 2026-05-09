---
status: draft
last_updated: 2026-05-09
---

# Adapters

How `FromSchema`, `FromOpenAPI`, `from_mcp`, and `scanner` work. How to add new adapters.

## FromSchema

**Source**: `src/from_schema.ts`
**Export**: `FromSchema` (main barrel)

### Purpose

Converts JSON Schema to TypeBox `TSchema`. Required because `OperationSpec.inputSchema` and `outputSchema` must be TypeBox schemas (for `Value.Check` validation), but external specs (OpenAPI, MCP) provide JSON Schema. In the future, `@alkdev/typemap` may replace or supplement `FromSchema` to support Zod and Valibot input schemas as well.

### Conversion Rules

| JSON Schema Construct | TypeBox Output |
|----------------------|---------------|
| `allOf` | `Type.IntersectEvaluated(rest, schema)` |
| `anyOf` | `Type.UnionEvaluated(rest, schema)` |
| `oneOf` | `Type.UnionEvaluated(rest, schema)` |
| `enum` | `Type.UnionEvaluated(literals)` |
| `object` (with `properties` + `required`) | `Type.Object(properties, schema)` — required fields are non-optional, others wrapped in `Type.Optional()` |
| `array` (with `items` array) | `Type.Tuple(rest, schema)` |
| `array` (with `items` object) | `Type.Array(FromSchema(items), schema)` |
| `const` | `Type.Literal(value, schema)` |
| `$ref` | `Type.Ref(path)` |
| `string` | `Type.String(schema)` |
| `number` | `Type.Number(schema)` |
| `integer` | `Type.Integer(schema)` |
| `boolean` | `Type.Boolean(schema)` |
| `null` | `Type.Null(schema)` |
| Unrecognized | `Type.Unknown(schema)` |

`$ref` resolution is **not** handled by `FromSchema` — callers must resolve `$ref` pointers to concrete schemas before passing them to `FromSchema`. See `FromOpenAPI` for how `resolveRefsRecursive` handles this.

### Usage

```ts
import { FromSchema } from "@alkdev/operations"

const typeboxSchema = FromSchema({
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
})
```

## FromOpenAPI

**Source**: `src/from_openapi.ts`
**Exports**: `FromOpenAPI`, `FromOpenAPIFile`, `FromOpenAPIUrl` (main barrel); `OpenAPISpec`, `OpenAPIOperation`, `OpenAPIParameter`, `HTTPServiceConfig`, `OpenAPIFS` (types)

### Purpose

Generates `OperationSpec & { handler }[]` from OpenAPI specs. Each path+method combination becomes an operation with an auto-generated `fetch` handler.

### `FromOpenAPI(spec, config)`

```ts
function FromOpenAPI(spec: OpenAPISpec, config: HTTPServiceConfig): Array<OperationSpec & { handler: OperationHandler }>
```

Processes all paths in the spec. For each path and method combination:

1. **Resolve `$ref`** — `resolveRefsRecursive` resolves all `$ref` pointers in the spec, handling circular references
2. **Build input schema** — merges path parameters, query parameters, and request body into a single `Type.Object`
3. **Build output schema** — extracts response schema from `200`/`201` content, falls back to `Type.Unknown()`
4. **Detect operation type** — `GET` → `QUERY`, `text/event-stream` response → `SUBSCRIPTION`, everything else → `MUTATION`
5. **Generate operation id** — uses `operationId` if present, otherwise normalizes `{method}_{path_parts}`
6. **Create handler** — auto-generated `fetch` handler that:
   - Interpolates path parameters into the URL
   - Passes query parameters as search params
   - Sends request body as JSON
   - Applies auth headers from config
   - Returns JSON, text, or `ArrayBuffer` based on response content type

### `FromOpenAPIFile(path, config, fs?)`

```ts
async function FromOpenAPIFile(
  path: string,
  config: HTTPServiceConfig,
  fs?: OpenAPIFS,
): Promise<Array<OperationSpec & { handler: OperationHandler }>>
```

Reads an OpenAPI JSON file. If `fs` is provided, uses `fs.readFile()` (runtime-agnostic). Otherwise, uses Node.js `node:fs/promises`.

### `FromOpenAPIUrl(url, config)`

```ts
async function FromOpenAPIUrl(
  url: string,
  config: HTTPServiceConfig,
): Promise<Array<OperationSpec & { handler: OperationHandler }>>
```

Fetches an OpenAPI JSON spec from a URL.

### `HTTPServiceConfig`

```ts
interface HTTPServiceConfig {
  namespace: string
  baseUrl: string
  headers?: Record<string, string>
  auth?: {
    type: "bearer" | "apiKey" | "basic"
    token?: string
    headerName?: string
    prefix?: string
  }
  timeout?: number
}
```

- `namespace` — operation namespace (e.g., `"opencode"`)
- `baseUrl` — base URL for all requests in this spec
- `auth` — bearer, apiKey (custom header), or basic auth
- `timeout` — `AbortSignal.timeout` for fetch calls

### `OpenAPIFS`

```ts
interface OpenAPIFS {
  readFile(path: string): Promise<string>
}
```

Injectable filesystem interface for runtime-agnostic file reading. See [ADR-002](decisions/002-fs-injection.md).

### Known Gap: SSE Subscription Handlers

`FromOpenAPI` correctly detects SSE endpoints (`text/event-stream` → `SUBSCRIPTION`) but the auto-generated handler does a one-shot `fetch` and returns the response body. For `SUBSCRIPTION` operations, the handler should be an async generator that:
1. Calls `fetch()` with the constructed URL/params
2. Reads the response body as a stream
3. Parses SSE frames (`data:` lines, `event:` lines)
4. Yields each parsed event
5. Cleans up on iteration stop

## from_mcp

**Source**: `src/from_mcp.ts`
**Exports**: `createMCPClient`, `closeMCPClient`, `MCPClientLoader` (sub-path `@alkdev/operations/from-mcp`)
**Peer dep**: `@modelcontextprotocol/sdk` (optional)

### Purpose

Connects to MCP (Model Context Protocol) servers and wraps their tools as `OperationSpec & { handler }[]`. Supports both stdio and HTTP transports.

### `createMCPClient(name, config)`

```ts
async function createMCPClient(
  name: string,
  config: MCPClientConfig,
): Promise<MCPClientWrapper>
```

1. Dynamic-import `@modelcontextprotocol/sdk` (peer dep — not loaded if MCP is not used)
2. Create transport: `StreamableHTTPClientTransport` for `url` config, `StdioClientTransport` for `command` config
3. Connect the client
4. Call `client.listTools()` to discover available tools
5. For each tool, create a `OperationSpec & { handler }`:
   - `name`: tool name
   - `namespace`: the `name` parameter (used as grouping)
   - `type`: `MUTATION` (all MCP tools are mutations)
   - `inputSchema`: `FromSchema(tool.inputSchema)` (converts JSON Schema to TypeBox)
   - `outputSchema`: `Type.Unknown()` (MCP doesn't provide output schemas)
   - `handler`: calls `client.callTool({ name, arguments })`
   - `accessControl`: `{ requiredScopes: [] }` (no auth by default)

### `MCPClientConfig`

```ts
interface MCPClientConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}
```

Either `command` (stdio transport) or `url` (HTTP transport) must be provided.

### `MCPClientLoader`

```ts
class MCPClientLoader {
  async load(config: Record<string, MCPClientConfig>): Promise<MCPClientWrapper[]>
  getClient(name: string): MCPClientWrapper | undefined
  getAllWrappers(): MCPClientWrapper[]
  getAllOperations(): Array<OperationSpec & { handler: OperationHandler }>
  async closeAll(): Promise<void>
}
```

Manages multiple MCP client connections. `load()` connects to all configured servers in sequence, `getAllOperations()` collects all tool operations from all connected clients, `closeAll()` gracefully shuts down all connections.

### Sub-Path Export

`from_mcp` is exported via sub-path `@alkdev/operations/from-mcp` because it has a peer dependency on `@modelcontextprotocol/sdk`. Consumers that don't use MCP don't need to install it. See [ADR-003](decisions/003-peer-dep-adapters.md).

## Scanner

**Source**: `src/scanner.ts`
**Exports**: `scanOperations` (main barrel), `OperationManifest`, `ScannerFS` (types)

### Purpose

Auto-discovers operation specs from the filesystem. Recursively scans `.ts` files, imports them, and validates that the default export satisfies `OperationSpecSchema`. Handlers must be registered separately via `registry.registerHandler()`.

### `scanOperations(dirPath, fs)`

```ts
async function scanOperations(
  dirPath: string,
  fs: ScannerFS,
): Promise<OperationSpec[]>
```

1. Walk directory tree using `fs.readdir()`
2. For each `.ts` file, construct a `file://` URL and dynamic `import()`
3. If the module has a default export, validate it against `OperationSpecSchema` using `collectErrors`
4. Valid specs are added to the result array; invalid ones log a warning and are skipped
5. Directories are recursed

Note: The scanner validates against `OperationSpecSchema` (no handler field). If a scanned module exports both spec and handler, use `registry.register()` instead.

### `ScannerFS`

```ts
interface ScannerFS {
  readdir(path: string): AsyncIterable<{ name: string; isFile: boolean; isDirectory: boolean }>
  cwd(): string
}
```

Injectable filesystem interface. No `Deno.*` globals or Node-specific imports in the scanner source. The consumer provides the FS implementation. See [ADR-002](decisions/002-fs-injection.md).

### Expected Module Shape

#### Spec + handler together (legacy, still supported)

```ts
// operations/myOperation.ts
import { Type } from "@alkdev/typebox"
import { OperationType, type IOperationDefinition } from "@alkdev/operations"

export default {
  name: "myOperation",
  namespace: "myapp",
  version: "1.0.0",
  type: OperationType.QUERY,
  description: "Does something useful",
  inputSchema: Type.Object({ name: Type.String() }),
  outputSchema: Type.Object({ result: Type.String() }),
  accessControl: { requiredScopes: ["read"] },
  handler: async (input) => ({ result: `Hello, ${input.name}` }),
} satisfies IOperationDefinition
```

#### Spec only (recommended for scanned modules)

```ts
// operations/myOperation.ts
import { Type } from "@alkdev/typebox"
import { OperationType, type OperationSpec } from "@alkdev/operations"

export default {
  name: "myOperation",
  namespace: "myapp",
  version: "1.0.0",
  type: OperationType.QUERY,
  description: "Does something useful",
  inputSchema: Type.Object({ name: Type.String() }),
  outputSchema: Type.Object({ result: Type.String() }),
  accessControl: { requiredScopes: ["read"] },
} satisfies OperationSpec
```

Then register the handler separately:

```ts
registry.registerSpec(scannedSpec)
registry.registerHandler("myapp.myOperation", myHandler)
```

## Adding a New Adapter

To add a new adapter (e.g., `from_grpc`):

1. **Create `src/from_grpc.ts`** — implement the adapter that produces `OperationSpec[]` (spec-only) or `Array<OperationSpec & { handler }>` (spec+handler)
2. **Export from `src/index.ts`** — add named exports to the barrel
3. **If the adapter has peer dependencies**:
   - Add to `peerDependencies` and `peerDependenciesMeta` in `package.json`
   - Add a sub-path entry in `exports` (e.g., `"./from-grpc"`)
   - Add a separate entry in `tsup.config.ts`
   - See [ADR-003](decisions/003-peer-dep-adapters.md)
4. **If handlers are provided**, they can be registered alongside specs or separately via `registry.registerHandler()`
5. **Inject runtime dependencies** — follow the `ScannerFS` / `OpenAPIFS` pattern for any filesystem or platform-specific APIs. See [ADR-002](decisions/002-fs-injection.md)
6. **Use `FromSchema`** for any JSON Schema → TypeBox conversion needed by the adapter (or `@alkdev/typemap` for Zod/Valibot)
7. **Write tests** — test the adapter in isolation, mock external services
8. **Update architecture docs** — add adapter section here and update the API surface table