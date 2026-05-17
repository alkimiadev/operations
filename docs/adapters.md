# Adapters

Adapters register operations from external sources. Each adapter converts external definitions (JSON Schema, OpenAPI, MCP tools) into `OperationSpec` + handler pairs that plug into the registry.

## FromSchema

`FromSchema` converts JSON Schema to TypeBox schemas. Used internally by OpenAPI and MCP adapters, but also useful standalone:

```ts
import { FromSchema } from "@alkdev/operations";

const typeboxSchema = FromSchema({
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "integer" },
  },
  required: ["name"],
});
```

Supports: `object`, `array`, `string`, `number`, `integer`, `boolean`, `null`, `enum`, `allOf`, `anyOf`, `oneOf`, `$ref`, `const`, and tuples.

## Schema Adapters (from-typemap)

If you use Zod or Valibot schemas instead of TypeBox, the `SchemaAdapter` interface lets you register operations with your preferred schema library:

```ts
import { OperationRegistry } from "@alkdev/operations";
import { zodAdapter } from "@alkdev/operations/from-typemap";
import { z } from "zod";

const adapter = zodAdapter();
await adapter.init();

const registry = new OperationRegistry({ schemaAdapter: adapter });

registry.register({
  name: "create",
  namespace: "task",
  version: "1.0.0",
  type: OperationType.MUTATION,
  description: "Create a task",
  inputSchema: z.object({ title: z.string() }),   // Zod schema!
  outputSchema: z.object({ id: z.string() }),
  accessControl: { requiredScopes: [] },
  handler: async (input) => ({ id: crypto.randomUUID(), ...input }),
});
```

### Available adapters

| Import | Adapter | Requires |
|--------|---------|----------|
| `defaultAdapter` | Pass-through TypeBox | Nothing |
| `zodAdapter()` | Zod → TypeBox via `@alkdev/typemap` | `@alkdev/typemap` + `zod` |
| `valibotAdapter()` | Valibot → TypeBox via `@alkdev/typemap` | `@alkdev/typemap` + `valibot` |

Import from the `from-typemap` sub-path:

```ts
import { zodAdapter, valibotAdapter, defaultAdapter } from "@alkdev/operations/from-typemap";
```

> `defaultAdapter` is used by `OperationRegistry` when no adapter is specified. It passes TypeBox schemas through unchanged and throws for non-TypeBox schemas.

## MCP Client (from-mcp)

Connect to MCP servers and register their tools as operations.

### createMCPClient

Create a single MCP client connection:

```ts
import { createMCPClient, closeMCPClient } from "@alkdev/operations/from-mcp";

const wrapper = await createMCPClient("my-server", {
  command: "npx",
  args: ["my-mcp-server"],
  env: { API_KEY: "..." },
});

// wrapper.tools is an array of OperationSpec + handler
registry.registerAll(wrapper.tools);

// When done:
await closeMCPClient(wrapper);
```

For HTTP-based servers:

```ts
const wrapper = await createMCPClient("remote-server", {
  url: "https://example.com/mcp",
  headers: { Authorization: "Bearer ..." },
});
```

### MCPClientLoader

Manages multiple MCP clients:

```ts
import { MCPClientLoader } from "@alkdev/operations/from-mcp";

const loader = new MCPClientLoader();
await loader.load({
  "filesystem": { command: "npx", args: ["@modelcontextprotocol/server-filesystem", "/tmp"] },
  "github": { command: "npx", args: ["@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "..." } },
});

// Register all tools into a registry
loader.registerAll(registry);

// Access individual clients:
const fsClient = loader.getClient("filesystem");

// Cleanup
await loader.closeAll();
```

### MCPClientConfig

| Field | Type | Description |
|-------|------|-------------|
| `command` | `string` | Stdio transport: command to run |
| `args` | `string[]` | Arguments for the command |
| `env` | `Record<string, string>` | Environment variables |
| `cwd` | `string` | Working directory |
| `url` | `string` | HTTP transport: server URL |
| `headers` | `Record<string, string>` | HTTP headers (for `url` transport) |
| `version` | `string` | Version string for the operation specs |

MCP tool results are wrapped in `mcpEnvelope()` with structured content blocks. If `structuredContent` is present and the output schema is not `Unknown`, it's cast through the schema.

## OpenAPI (from-openapi)

Import REST API operations from OpenAPI specs.

### FromOpenAPI

```ts
import { FromOpenAPI } from "@alkdev/operations/from-openapi";

const operations = FromOpenAPI(spec, {
  namespace: "petstore",
  baseUrl: "https://petstore.example.com",
  headers: { Authorization: "Bearer ..." },
});

registry.registerAll(operations);
```

### FromOpenAPIFile

```ts
import { FromOpenAPIFile } from "@alkdev/operations/from-openapi";

const operations = await FromOpenAPIFile("./openapi.json", {
  namespace: "petstore",
  baseUrl: "https://petstore.example.com",
});
```

For Deno or other non-Node runtimes, inject an `OpenAPIFS`:

```ts
const operations = await FromOpenAPIFile("./openapi.json", config, {
  readFile: async (path) => Deno.readTextFile(path),
});
```

### FromOpenAPIUrl

```ts
import { FromOpenAPIUrl } from "@alkdev/operations/from-openapi";

const operations = await FromOpenAPIUrl("https://petstore.example.com/openapi.json", config);
```

### OpenAPIServiceRegistry

Manages multiple OpenAPI services:

```ts
import { OpenAPIServiceRegistry } from "@alkdev/operations/from-openapi";

const serviceRegistry = new OpenAPIServiceRegistry();
serviceRegistry.add("petstore", spec, config);
await serviceRegistry.addFromUrl("github", "https://api.github.com/openapi.json", config);
serviceRegistry.registerAll(registry);
```

### HTTPServiceConfig

| Field | Type | Description |
|-------|------|-------------|
| `namespace` | `string` | Namespace for generated operations |
| `baseUrl` | `string` | Base URL for HTTP requests |
| `headers` | `Record<string, string>` | Default headers |
| `auth` | `object` | Auth config: `bearer`, `apiKey`, or `basic` |
| `timeout` | `number` | Request timeout in ms |
| `fetch` | `typeof fetch` | Custom fetch implementation |

### SSE Support

Operations with `text/event-stream` response content type are automatically typed as `SUBSCRIPTION`. The handler returns an async generator that parses SSE frames and yields `httpEnvelope` events.

### Operation Type Detection

- `GET` → `QUERY`
- `POST`/`PUT`/`PATCH`/`DELETE` → `MUTATION`
- Any method with `text/event-stream` response → `SUBSCRIPTION`

## Scanner

`scanOperations` auto-discovers operations from the filesystem by importing `.ts` files that export a default `OperationSpec`:

```ts
import { scanOperations } from "@alkdev/operations";

const specs = await scanOperations("./operations", {
  readdir: async function* (path) { /* ... */ },
  cwd: () => process.cwd(),
});
```

The `ScannerFS` interface makes it runtime-agnostic:

```ts
interface ScannerFS {
  readdir(path: string): AsyncIterable<{ name: string; isFile: boolean; isDirectory: boolean }>;
  cwd(): string;
}
```

Each `.ts` file must export a default that validates against `OperationSpecSchema`. Files that don't pass validation are skipped with a warning.