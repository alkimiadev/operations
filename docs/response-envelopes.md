# Response Envelopes

All operation results are wrapped in a `ResponseEnvelope<T>` that carries transport metadata alongside the data. This provides a uniform result type regardless of whether the operation ran locally, over HTTP, or via MCP.

## Structure

```ts
interface ResponseEnvelope<T = unknown> {
  data: T;
  meta: ResponseMeta;
}
```

`meta.source` is the discriminant:

| Source | Type | Carries |
|--------|------|---------|
| `"local"` | `LocalResponseMeta` | `operationId`, `timestamp` |
| `"http"` | `HTTPResponseMeta` | `statusCode`, `headers`, `contentType` |
| `"mcp"` | `MCPResponseMeta` | `isError`, `content[]`, `structuredContent?`, `_meta?` |

## Creating Envelopes

### localEnvelope

For in-process results:

```ts
import { localEnvelope } from "@alkdev/operations";

const env = localEnvelope({ id: "123", title: "My task" }, "task.create");
```

### httpEnvelope

For HTTP-sourced results (e.g., OpenAPI adapter):

```ts
import { httpEnvelope } from "@alkdev/operations";

const env = httpEnvelope(data, {
  statusCode: 200,
  headers: { "content-type": "application/json" },
  contentType: "application/json",
});
```

### mcpEnvelope

For MCP-sourced results:

```ts
import { mcpEnvelope } from "@alkdev/operations";

const env = mcpEnvelope(data, {
  isError: false,
  content: [{ type: "text", text: "Done" }],
});
```

## Unwrapping

```ts
import { unwrap } from "@alkdev/operations";

const result = unwrap(envelope);
```

Returns `envelope.data`, discarding transport metadata.

## Detecting Envelopes

```ts
import { isResponseEnvelope } from "@alkdev/operations";

if (isResponseEnvelope(maybeEnvelope)) {
  // TypeScript narrows to ResponseEnvelope
}
```

Checks that the value has `data` and `meta` with a recognized `source` ("local" | "http" | "mcp") and the appropriate source-specific fields.

## Automatic Wrapping

When an operation handler returns a plain value (not a `ResponseEnvelope`), `registry.execute()` and `subscribe()` wrap it in a `localEnvelope()` automatically. If the handler already returns a `ResponseEnvelope`, it passes through unchanged.

## MCP Content Blocks

MCP responses include structured content blocks:

```ts
type MCPContentBlock =
  | { type: "text"; text: string; annotations?: MCPAnnotations }
  | { type: "image"; data: string; mimeType: string; annotations?: MCPAnnotations }
  | { type: "audio"; data: string; mimeType: string; annotations?: MCPAnnotations }
  | { type: "resource"; resource: MCPResourceContent; annotations?: MCPAnnotations }
  | { type: "resource_link"; uri: string; name: string; description?: string; mimeType?: string }
```

## TypeBox Schemas

Both `ResponseEnvelopeSchema` and `ResponseMetaSchema` are available for runtime validation:

```ts
import { ResponseEnvelopeSchema, ResponseMetaSchema } from "@alkdev/operations";
import { Value } from "@alkdev/typebox/value";

if (Value.Check(ResponseEnvelopeSchema, value)) {
  // valid envelope
}
```