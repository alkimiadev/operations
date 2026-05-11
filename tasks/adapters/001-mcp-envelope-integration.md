---
id: mcp-envelope-integration
name: Update from_mcp adapter to use mcpEnvelope, structuredContent, and outputSchema extraction
status: completed
depends_on: [response-envelope-types]
scope: moderate
risk: medium
impact: component
level: implementation
---

## Description

Update `src/from_mcp.ts` to align with the response envelope specification documented in `response-envelopes.md` § MCP Adapter, `adapters.md` § from_mcp, and the drift tables in `call-protocol.md` and `api-surface.md`.

Changes needed (current source → target):

| What | Current source | Target |
|------|---------------|--------|
| `outputSchema` at discovery time | `Type.Unknown()` for all tools | `tool.outputSchema ? FromSchema(tool.outputSchema) : Type.Unknown()` |
| Handler return value | Returns `result.content` (line 79) | Returns `mcpEnvelope(data, meta)` |
| `structuredContent` | Not used | Prefer as `data` when present; fall back to `mapMCPContentBlocks(result.content)` |
| `isError` handling | Throws `Error` (line 76) | Wraps in envelope with `meta.isError: true`, does NOT throw |
| `Value.Cast()` | Not used | If `structuredContent && outputSchema !== Unknown`, cast `Value.Cast(outputSchema, structuredContent)` |

Implementation details:

1. **`outputSchema` extraction**: When `tool.outputSchema` is present (MCP spec 2025-06-18+), convert it to TypeBox via `FromSchema(tool.outputSchema)`. Fall back to `Type.Unknown()`.

2. **Handler behavior**: The handler should use `mcpEnvelope()` to wrap results:
   ```ts
   handler: async (input, context) => {
     const result = await client.callTool({ name: tool.name, arguments: input })
     const data = result.structuredContent
       ? (spec.outputSchema !== Type.Unknown()
           ? Value.Cast(spec.outputSchema, result.structuredContent)
           : result.structuredContent)
       : mapMCPContentBlocks(result.content)
     return mcpEnvelope(data, {
       isError: result.isError ?? false,
       content: mapMCPContentBlocks(result.content),
       structuredContent: result.structuredContent,
       _meta: result._meta,
     })
   }
   ```

3. **`mapMCPContentBlocks()`**: A helper function that maps SDK `ContentBlock[]` to our `MCPContentBlock[]` types. Unknown block types are mapped to `{ type: "text", text: JSON.stringify(block) }` as fallback.

4. **`isError` no longer throws**: MCP errors are represented as data, not thrown exceptions. Only transport-level errors (connection failure, tool not found) throw.

5. **The tool iteration** needs to capture `outputSchema` per tool since the handler closure needs it for `Value.Cast`.

## Acceptance Criteria

- [ ] `tool.outputSchema` is converted via `FromSchema()` when present; falls back to `Type.Unknown()`
- [ ] Handler returns `mcpEnvelope()` — never raw content and never throws on `isError`
- [ ] `structuredContent` is preferred as data when present
- [ ] `mapMCPContentBlocks()` helper maps SDK content blocks to our `MCPContentBlock[]` types
- [ ] Unknown MCP content block types fall back to `{ type: "text", text: JSON.stringify(block) }`
- [ ] `Value.Cast()` normalization applied when `outputSchema !== Type.Unknown()` and `structuredContent` is present
- [ ] `isError: true` results are wrapped in envelope, not thrown
- [ ] Transport-level errors (connection, etc.) still throw `CallError`
- [ ] `MCPClientWrapper.tools` type still returns `Array<OperationSpec & { handler: OperationHandler }>`
- [ ] Existing tests updated; new tests for envelope wrapping, structuredContent, isError handling
- [ ] `npm run build` passes, `npm run lint` passes, `npm test` passes

## References

- docs/architecture/adapters.md § from_mcp (Implementation changes needed table)
- docs/architecture/response-envelopes.md § MCP Adapter, § Handler behavior change
- docs/architecture/api-surface.md § Source vs. Spec Drift (from_mcp row)
- src/from_mcp.ts

## Notes

Merged `feat/response-envelope-types` branch first to get `ResponseEnvelope` types. The `Kind` symbol from `@alkdev/typebox` is used to detect `Type.Unknown()` schema at runtime, with a fallback to empty-object detection.

## Summary

Implemented MCP adapter envelope integration in `src/from_mcp.ts`:
- Created: `test/from_mcp.test.ts` (20 tests)
- Modified: `src/from_mcp.ts`
  - `outputSchema` extraction from `tool.outputSchema` via `FromSchema()`, falls back to `Type.Unknown()`
  - Handler returns `mcpEnvelope()` with structured/legacy data path
  - `structuredContent` preferred as `data` when present, `Value.Cast()` applied when `outputSchema` is not Unknown
  - `isError: true` wrapped in envelope meta, NOT thrown
  - Transport-level config errors throw `CallError`
  - Added `mapMCPContentBlocks()` exported helper mapping SDK `ContentBlock[]` to our `MCPContentBlock[]`
  - Unknown block types fall back to `{ type: "text", text: JSON.stringify(block) }`
  - Removed unused `OperationContext` import
- Build, lint, and all 95 tests pass