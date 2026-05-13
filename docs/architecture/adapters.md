---
status: draft
last_updated: 2026-05-11
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

Generates `OperationSpec & { handler }[]` from OpenAPI specs. Each path+method combination becomes an operation with an auto-generated handler. QUERY and MUTATION operations use `OperationHandler` (single-return); SUBSCRIPTION operations use `SubscriptionHandler` (AsyncGenerator).

### `FromOpenAPI(spec, config)`

```ts
function FromOpenAPI(spec: OpenAPISpec, config: HTTPServiceConfig): Array<OperationSpec & { handler: OperationHandler | SubscriptionHandler }>
```

Processes all paths in the spec. For each path and method combination:

1. **Resolve `$ref`** — `resolveRefsRecursive` resolves all `$ref` pointers in the spec, handling circular references
2. **Build input schema** — merges path parameters, query parameters, and request body into a single `Type.Object`
3. **Build output schema** — extracts response schema from `200`/`201` content, falls back to `Type.Unknown()`
4. **Detect operation type** — `GET` → `QUERY`, `text/event-stream` response → `SUBSCRIPTION`, everything else → `MUTATION`
5. **Generate operation id** — uses `operationId` if present, otherwise normalizes `{method}_{path_parts}`
6. **Create handler** — based on detected operation type:
   - **QUERY / MUTATION**: auto-generated `OperationHandler` (async function) that:
     - Interpolates path parameters into the URL
     - Passes query parameters as search params
     - Sends request body as JSON
     - Applies auth headers from config
     - Returns JSON, text, or `ArrayBuffer` based on response content type
     - Wraps result in `httpEnvelope()` with HTTP metadata
   - **SUBSCRIPTION**: auto-generated `SubscriptionHandler` (AsyncGenerator) that:
     - Calls `fetch()` with the constructed URL/params
     - Reads the response body as a `ReadableStream`
     - Parses SSE frames (`data:`, `event:`, `id:` fields per WHATWG specification)
     - Yields each parsed event wrapped in `httpEnvelope()` with `contentType: "text/event-stream"`
     - Closes the stream on iteration stop or error (in `finally` block)
     - Throws `CallError("EXECUTION_ERROR", ...)` on HTTP error status or connection errors

The handler wraps results in `httpEnvelope()` with HTTP metadata (status code, headers, content type). On HTTP error status, it throws `CallError("EXECUTION_ERROR", ...)`. `Value.Cast()` normalization against `outputSchema` is applied by `registry.execute()` and `CallHandler` as part of the shared result pipeline — see [response-envelopes.md](response-envelopes.md#shared-result-pipeline).

### `FromOpenAPIFile(path, config, fs?)`

```ts
async function FromOpenAPIFile(
  path: string,
  config: HTTPServiceConfig,
  fs?: OpenAPIFS,
): Promise<Array<OperationSpec & { handler: OperationHandler | SubscriptionHandler }>>
```

Reads an OpenAPI JSON file. If `fs` is provided, uses `fs.readFile()` (runtime-agnostic). Otherwise, uses Node.js `node:fs/promises`.

### `FromOpenAPIUrl(url, config)`

```ts
async function FromOpenAPIUrl(
  url: string,
  config: HTTPServiceConfig,
): Promise<Array<OperationSpec & { handler: OperationHandler | SubscriptionHandler }>>
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

### SSE Subscription Handlers

`FromOpenAPI` detects SSE endpoints by response content type (`text/event-stream` → `SUBSCRIPTION`) and generates an `AsyncGenerator` handler (not a single-return `OperationHandler`). This makes SSE operations consumable via `subscribe()` and compatible with the call protocol's subscription transport.

#### Handler Pattern

For `SUBSCRIPTION`-type operations, `createHTTPOperation` generates a `SubscriptionHandler` — an `AsyncGenerator` that:

1. Calls `fetch()` with the constructed URL, query params, headers (including auth)
2. Reads the response body as a `ReadableStream`
3. Parses SSE frames from the stream (`data:`, `event:`, `id:` fields per the [SSE specification](https://html.spec.whatwg.org/multipage/server-sent-events.html))
4. Yields each parsed event, wrapped in `httpEnvelope()`
5. Cleans up the stream and response on iteration stop or error

#### SSE Parsing

SSE frames are parsed from the text stream according to the [WHATWG specification](https://html.spec.whatwg.org/multipage/server-sent-events.html):

- **BOM**: A U+FEFF BYTE ORDER MARK at the start of the stream is ignored (per spec §9.2)
- **Line endings**: Lines are split on `\n`, `\r\n`, or `\r` — all three are valid SSE line terminators
- **`data:` lines**: The text after `data:` is appended to the current data buffer. If the text after `data:` starts with a single U+0020 SPACE character, that space is removed (per the spec's "remove U+0020" step). Multiple `data:` lines before a dispatch are joined with `\n`
- **`event:` lines**: Set the event type for the next dispatch (default: `"message"` if no `event:` line)
- **`id:` lines**: Set the last event ID for reconnection
- **`:` lines**: Comments, ignored
- **Empty line**: Dispatches the buffered event (data buffer + event type + last event ID) and resets the parser state
- **Partial lines across `read()` calls**: The parser must retain unprocessed text in a buffer and prepend it to the next chunk. The SSE stream is a continuous text stream; line boundaries don't align with `ReadableStream.read()` boundaries

Parsing function signature:

```ts
function parseSSEFrames(buffer: string): { events: SSEEvent[], remaining: string }
```

Where `SSEEvent` is:

```ts
interface SSEEvent {
  data: string    // Joined data fields
  eventType: string  // From "event:" line, default "message"
  lastEventId: string  // From "id:" line
}
```

The `data` field value is the raw joined string (typically JSON). Consumers decide whether to `JSON.parse()` based on the operation's `outputSchema` or content type heuristics.

**Error handling**: Malformed lines (e.g., lines with no recognized field prefix) are logged as warnings and skipped. The stream continues processing subsequent lines.

Each dispatched event yields:

```ts
yield httpEnvelope(parsedData, {
  statusCode: response.status,
  headers: responseHeaders,
  contentType: "text/event-stream",
})
```

The SSE `event` type and `id` fields are currently **dropped** by the parser — they are not carried in the `ResponseEnvelope`. The `data` field value (the parsed SSE data, typically JSON) is the primary `envelope.data` payload. If consumers need per-event SSE metadata (event type, last event ID), a future `SSEResponseMeta` source type can be added. See [ADR-007](decisions/007-subscription-transport.md) § Open Questions.

#### SSE vs Single-Return Handler

| Aspect | QUERY / MUTATION handler | SUBSCRIPTION handler |
|--------|-------------------------|---------------------|
| Type | `OperationHandler` (returns single value) | `SubscriptionHandler` (AsyncGenerator) |
| Fetch pattern | One request, one response | One request, stream response body |
| Return value | `httpEnvelope(data, meta)` per call | `httpEnvelope(data, meta)` per yield |
| `execute()` | Returns `Promise<ResponseEnvelope>` | Not called via `execute()` — use `subscribe()` |
| Cleanup | Automatic (response consumed) | Must close `ReadableStream` on iteration stop |

#### Error Handling

- **Connection errors** (DNS, timeout): throw `CallError("EXECUTION_ERROR", ...)` from the generator body before the first yield
- **HTTP error status**: throw `CallError("EXECUTION_ERROR", ...)` from the generator body
- **Stream parse errors**: log warning and skip the malformed frame, continue the stream
- **Consumer cancellation**: the generator's `finally` block closes the `ReadableStream` and releases resources

#### Relationship to Call Protocol Subscriptions

SSE operations registered via `FromOpenAPI` are consumable through both:

1. **In-process**: `subscribe(registry, operationId, input, context)` — calls the AsyncGenerator directly, yields `ResponseEnvelope` per SSE event
2. **Remote**: `PendingRequestMap.subscribe(operationId, input, options)` — publishes `call.requested` and yields each `call.responded` event over the configured transport (WebSocket, Redis, etc.)

The handler itself is transport-agnostic. It yields `ResponseEnvelope` values via `httpEnvelope()`. The subscription consumption layer (local `subscribe()` or remote `PendingRequestMap.subscribe()`) handles the routing.

#### Runtime-Agnostic Fetch

The handler uses the global `fetch()` API, which is available in Node.js (18+), Deno, Bun, and modern browsers. No platform-specific `http` module is imported. For runtimes that require a polyfill, the consumer can set `globalThis.fetch` before calling `FromOpenAPI`.

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
### `FromSchema(tool.inputSchema)` (converts JSON Schema to TypeBox)
     - `outputSchema`: `tool.outputSchema ? FromSchema(tool.outputSchema) : Type.Unknown()` (MCP spec 2025-06-18+ provides `outputSchema`; older tools lack it)
     - `handler`: calls `client.callTool({ name, arguments })`, wraps result in `mcpEnvelope()`
     - `accessControl`: `{ requiredScopes: [] }` (no auth by default)

The handler returns pre-built `ResponseEnvelope` instances via `mcpEnvelope()`. `isError: true` results are wrapped in the envelope (not thrown), so consumers check `envelope.meta.isError`. `structuredContent` is preferred as `envelope.data` when available; otherwise `mapMCPContentBlocks(result.content)` is used. `Value.Cast()` normalization against `outputSchema` is applied by `registry.execute()` and `CallHandler` as part of the shared result pipeline.

### outputSchema and structuredContent

The MCP spec (2025-06-18+) adds `outputSchema` to tool definitions and `structuredContent` to `CallToolResult`. When a tool declares `outputSchema`:

1. At discovery time: `FromSchema(tool.outputSchema)` converts the JSON Schema to TypeBox, giving the operation a meaningful `outputSchema`
2. At call time: `result.structuredContent` contains data matching that schema
3. The handler uses `Value.Cast(spec.outputSchema, result.structuredContent)` to normalize the data against the TypeBox schema — stripping excess properties from the MCP envelope and filling defaults
4. `envelope.data` is the cast result, which matches `outputSchema` — **fully composable with local operations**

When a tool does NOT declare `outputSchema`:

1. `outputSchema` is `Type.Unknown()` — no type information available
2. `result.structuredContent` is absent
3. `envelope.data` is `MCPContentBlock[]` — not composable, consumer must inspect content blocks
4. Some MCP servers return `JSON.stringify`'d data in text content blocks — the adapter could attempt `JSON.parse()` but this is fragile and not currently implemented

See [response-envelopes.md](response-envelopes.md) for the full envelope specification and envelope stripping with `Value.Cast()`.

The `CallToolResult` type in the installed SDK (`@modelcontextprotocol/sdk` DRAFT-2026-v1) includes `structuredContent?: { [key: string]: unknown }` and the `Tool` type includes `outputSchema?`. The adapter code extracts `outputSchema` at discovery time and uses `structuredContent` at call time.

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