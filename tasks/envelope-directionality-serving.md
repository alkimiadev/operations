# Task: Envelope Directionality — Serving Operations via MCP and HTTP

**Priority**: Medium (blocks hub serving operations to spokes)

**Dependencies**: ADR-005 (response envelopes implemented), ADR-006 (unified invocation path)

**Architecture docs**: [response-envelopes.md](../docs/architecture/response-envelopes.md) § Open Questions #4

## Problem

The current design covers **consuming** remote operations (MCP, OpenAPI) and wrapping their results in `ResponseEnvelope`. The reverse direction — **serving** local operations via MCP or OpenAPI — is not yet addressed.

When the hub exposes operations as an MCP server, results must be wrapped in MCP's `CallToolResult` format (`structuredContent` + `content`). When exposing as OpenAPI, results must be serialized as HTTP response bodies. How `ResponseEnvelope` results get converted to these protocol-specific formats is an open design question.

## Design Questions to Answer

1. **Where does the conversion happen?** Does the hub call `registry.execute()`, get a `ResponseEnvelope`, and then convert it? Or does a serving adapter register as a handler that wraps and returns protocol-native types?

2. **What happens to envelope metadata when serving?** A local operation's `ResponseEnvelope` has `meta: { source: "local", operationId, timestamp }`. When served as MCP, should this become `_meta` on the `CallToolResult`? When served as HTTP, should the timestamp become a `X-Operation-Timestamp` header?

3. **Access control direction for serving**: When serving operations, access control is "what operations does this connected spoke have access to?" vs the consuming direction which is "does the caller have scopes for this operation?"

4. **How do subscription (SUBSCRIPTION) operations work in the serving direction?** When a spoke calls an MCP tool that maps to a SUBSCRIPTION operation on the hub, the result is a stream. How does this map to MCP's response model? MCP doesn't natively have streaming tool results.

5. **Relationship to existing adapters**: `from_mcp` and `from_openapi` are currently one-directional (consume external → register operations). Would "to" variants (`to_mcp`, `to_openapi`) be separate modules, or would the existing adapters gain serving capabilities?

## Scope

Design-only task. Produce:

1. A decision document (ADR or architecture section) answering the questions above
2. An API sketch showing the serving adapter interfaces
3. Identification of implementation work needed

## Constraints

- Must work with the existing `ResponseEnvelope` model — don't change the envelope to accommodate serving
- Must handle all three operation types (QUERY, MUTATION, SUBSCRIPTION)
- Runtime-agnostic (same as rest of package)
- Coherent with ADR-005 and ADR-006
