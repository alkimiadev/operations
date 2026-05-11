import { describe, it, expect } from "vitest";
import {
  localEnvelope,
  httpEnvelope,
  mcpEnvelope,
  isResponseEnvelope,
  unwrap,
  RESPONSE_SOURCES,
  ResponseEnvelopeSchema,
  ResponseMetaSchema,
} from "../src/response-envelope.js";
import type {
  ResponseEnvelope,
  ResponseMeta,
  LocalResponseMeta,
  HTTPResponseMeta,
  MCPResponseMeta,
  MCPContentBlock,
  MCPAnnotations,
  MCPResourceContent,
  ResponseSource,
} from "../src/response-envelope.js";
import { Value } from "@alkdev/typebox/value";

describe("localEnvelope", () => {
  it("wraps data with correct meta (source, operationId, timestamp)", () => {
    const data = { name: "test", count: 42 };
    const envelope = localEnvelope(data, "ns.myOp");

    expect(envelope.data).toEqual({ name: "test", count: 42 });
    expect(envelope.meta.source).toBe("local");
    expect(envelope.meta.operationId).toBe("ns.myOp");
    expect(typeof envelope.meta.timestamp).toBe("number");
    expect(envelope.meta.timestamp).toBeLessThanOrEqual(Date.now());
    expect(envelope.meta.timestamp).toBeGreaterThan(Date.now() - 1000);
  });

  it("wraps primitive data", () => {
    const envelope = localEnvelope("hello", "op.string");
    expect(envelope.data).toBe("hello");
    expect(envelope.meta.source).toBe("local");
  });

  it("wraps null data", () => {
    const envelope = localEnvelope(null, "op.null");
    expect(envelope.data).toBeNull();
    expect(envelope.meta.source).toBe("local");
  });

  it("wraps undefined data (void handler)", () => {
    const envelope = localEnvelope(undefined, "op.void");
    expect(envelope.data).toBeUndefined();
    expect(envelope.meta.source).toBe("local");
  });

  it("sets a fresh timestamp for each call", () => {
    const before = Date.now();
    const envelope = localEnvelope("a", "op.a");
    const after = Date.now();
    expect(envelope.meta.timestamp).toBeGreaterThanOrEqual(before);
    expect(envelope.meta.timestamp).toBeLessThanOrEqual(after);
  });
});

describe("httpEnvelope", () => {
  it("wraps data with correct meta (source: http, statusCode, headers, contentType)", () => {
    const data = { result: "ok" };
    const meta = {
      statusCode: 200,
      headers: { "content-type": "application/json", "x-request-id": "abc123" },
      contentType: "application/json",
    };
    const envelope = httpEnvelope(data, meta);

    expect(envelope.data).toEqual({ result: "ok" });
    expect(envelope.meta).toEqual({
      source: "http",
      statusCode: 200,
      headers: { "content-type": "application/json", "x-request-id": "abc123" },
      contentType: "application/json",
    });
  });

  it("wraps string data with 404 status", () => {
    const envelope = httpEnvelope("Not Found", {
      statusCode: 404,
      headers: {},
      contentType: "text/plain",
    });

    expect(envelope.data).toBe("Not Found");
    expect(envelope.meta.source).toBe("http");
    expect(envelope.meta.statusCode).toBe(404);
  });

  it("preserves all meta fields from input", () => {
    const meta = {
      statusCode: 201,
      headers: { location: "/resource/1" },
      contentType: "application/json",
    };
    const envelope = httpEnvelope({ id: 1 }, meta);

    expect(envelope.meta).toEqual({ source: "http", ...meta });
  });
});

describe("mcpEnvelope", () => {
  it("wraps data with correct meta (source: mcp, isError, content, structuredContent, _meta)", () => {
    const data = { temperature: 72 };
    const content: MCPContentBlock[] = [
      { type: "text", text: "The temperature is 72°F" },
    ];
    const meta = {
      isError: false,
      content,
      structuredContent: { temperature: 72 } as Record<string, unknown>,
    };
    const envelope = mcpEnvelope(data, meta);

    expect(envelope.data).toEqual({ temperature: 72 });
    expect(envelope.meta).toEqual({
      source: "mcp",
      isError: false,
      content,
      structuredContent: { temperature: 72 },
    });
  });

  it("wraps data with isError: true and _meta", () => {
    const content: MCPContentBlock[] = [
      { type: "text", text: "Tool execution failed" },
    ];
    const envelope = mcpEnvelope(null, {
      isError: true,
      content,
      _meta: { requestId: "req-001" } as Record<string, unknown>,
    });

    expect(envelope.data).toBeNull();
    expect(envelope.meta.source).toBe("mcp");
    expect(envelope.meta.isError).toBe(true);
    expect(envelope.meta._meta).toEqual({ requestId: "req-001" });
  });

  it("works with minimal meta (only required fields)", () => {
    const content: MCPContentBlock[] = [];
    const envelope = mcpEnvelope("result", {
      isError: false,
      content,
    });

    expect(envelope.data).toBe("result");
    expect(envelope.meta.structuredContent).toBeUndefined();
    expect(envelope.meta._meta).toBeUndefined();
  });

  it("wraps structuredContent as data when provided", () => {
    const structured = { key: "value" } as Record<string, unknown>;
    const content: MCPContentBlock[] = [
      { type: "text", text: "result" },
    ];
    const envelope = mcpEnvelope(structured, {
      isError: false,
      content,
      structuredContent: structured,
    });

    expect(envelope.data).toBe(structured);
    expect(envelope.meta.structuredContent).toBe(structured);
  });
});

describe("isResponseEnvelope", () => {
  it("returns true for local envelope", () => {
    const envelope = localEnvelope({ x: 1 }, "op.test");
    expect(isResponseEnvelope(envelope)).toBe(true);
  });

  it("returns true for http envelope", () => {
    const envelope = httpEnvelope("ok", {
      statusCode: 200,
      headers: {},
      contentType: "text/plain",
    });
    expect(isResponseEnvelope(envelope)).toBe(true);
  });

  it("returns true for mcp envelope", () => {
    const envelope = mcpEnvelope("result", {
      isError: false,
      content: [],
    });
    expect(isResponseEnvelope(envelope)).toBe(true);
  });

  it("returns false for null", () => {
    expect(isResponseEnvelope(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isResponseEnvelope(undefined)).toBe(false);
  });

  it("returns false for empty object", () => {
    expect(isResponseEnvelope({})).toBe(false);
  });

  it("returns false for object with only data", () => {
    expect(isResponseEnvelope({ data: "hello" })).toBe(false);
  });

  it("returns false for object with only meta", () => {
    expect(isResponseEnvelope({ meta: { source: "local" } })).toBe(false);
  });

  it("returns false for object with meta.source not in known set", () => {
    expect(isResponseEnvelope({ data: "hello", meta: { source: "websocket" } })).toBe(false);
  });

  it("returns false for non-object primitives", () => {
    expect(isResponseEnvelope(42)).toBe(false);
    expect(isResponseEnvelope("string")).toBe(false);
    expect(isResponseEnvelope(true)).toBe(false);
  });

  it("returns false when meta is null", () => {
    expect(isResponseEnvelope({ data: "hello", meta: null })).toBe(false);
  });

  it("returns true for envelope with undefined data (void handler)", () => {
    const envelope = localEnvelope(undefined, "op.void");
    expect(isResponseEnvelope(envelope)).toBe(true);
  });

  it("returns false for array", () => {
    expect(isResponseEnvelope([1, 2, 3])).toBe(false);
  });

  it("returns false for object with numeric meta", () => {
    expect(isResponseEnvelope({ data: "hello", meta: 42 })).toBe(false);
  });
});

describe("unwrap", () => {
  it("returns envelope.data for local envelope", () => {
    const envelope = localEnvelope({ result: 42 }, "op.compute");
    expect(unwrap(envelope)).toEqual({ result: 42 });
  });

  it("returns envelope.data for http envelope", () => {
    const envelope = httpEnvelope("response body", {
      statusCode: 200,
      headers: { "content-type": "text/plain" },
      contentType: "text/plain",
    });
    expect(unwrap(envelope)).toBe("response body");
  });

  it("returns envelope.data for mcp envelope", () => {
    const data = { items: [1, 2, 3] };
    const envelope = mcpEnvelope(data, {
      isError: false,
      content: [],
    });
    expect(unwrap(envelope)).toBe(data);
  });

  it("returns undefined for void envelope data", () => {
    const envelope = localEnvelope(undefined, "op.void");
    expect(unwrap(envelope)).toBeUndefined();
  });

  it("returns null for null envelope data", () => {
    const envelope = localEnvelope(null, "op.null");
    expect(unwrap(envelope)).toBeNull();
  });
});

describe("RESPONSE_SOURCES", () => {
  it("contains all known source types", () => {
    expect(RESPONSE_SOURCES).toEqual(["local", "http", "mcp"]);
  });
});

describe("TypeBox schemas", () => {
  describe("ResponseEnvelopeSchema", () => {
    it("validates correct envelope shape", () => {
      const envelope = localEnvelope({ value: 1 }, "op.test");
      expect(Value.Check(ResponseEnvelopeSchema, envelope)).toBe(true);
    });

    it("validates http envelope shape", () => {
      const envelope = httpEnvelope({ ok: true }, {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        contentType: "application/json",
      });
      expect(Value.Check(ResponseEnvelopeSchema, envelope)).toBe(true);
    });

    it("validates mcp envelope shape", () => {
      const envelope = mcpEnvelope("result", {
        isError: false,
        content: [{ type: "text", text: "result" }],
      });
      expect(Value.Check(ResponseEnvelopeSchema, envelope)).toBe(true);
    });

    it("rejects object without data", () => {
      const value = { meta: { source: "local", operationId: "op", timestamp: Date.now() } };
      expect(Value.Check(ResponseEnvelopeSchema, value)).toBe(false);
    });

    it("rejects object without meta", () => {
      const value = { data: "hello" };
      expect(Value.Check(ResponseEnvelopeSchema, value)).toBe(false);
    });

    it("rejects object with invalid meta source", () => {
      const value = { data: "hello", meta: { source: "grpc", operationId: "op", timestamp: 1 } };
      expect(Value.Check(ResponseEnvelopeSchema, value)).toBe(false);
    });

    it("rejects object with missing meta fields", () => {
      const value = { data: "hello", meta: { source: "local" } };
      expect(Value.Check(ResponseEnvelopeSchema, value)).toBe(false);
    });
  });

  describe("ResponseMetaSchema", () => {
    it("validates LocalResponseMeta", () => {
      const meta: LocalResponseMeta = { source: "local", operationId: "op.test", timestamp: Date.now() };
      expect(Value.Check(ResponseMetaSchema, meta)).toBe(true);
    });

    it("validates HTTPResponseMeta", () => {
      const meta: HTTPResponseMeta = {
        source: "http",
        statusCode: 200,
        headers: { "content-type": "application/json" },
        contentType: "application/json",
      };
      expect(Value.Check(ResponseMetaSchema, meta)).toBe(true);
    });

    it("validates MCPResponseMeta", () => {
      const meta: MCPResponseMeta = {
        source: "mcp",
        isError: false,
        content: [{ type: "text", text: "result" }],
      };
      expect(Value.Check(ResponseMetaSchema, meta)).toBe(true);
    });

    it("validates MCPResponseMeta with optional fields", () => {
      const meta: MCPResponseMeta = {
        source: "mcp",
        isError: false,
        content: [],
        structuredContent: { key: "value" },
        _meta: { traceId: "abc" },
      };
      expect(Value.Check(ResponseMetaSchema, meta)).toBe(true);
    });

    it("rejects object with unknown source", () => {
      const value = { source: "websocket", timestamp: 1 };
      expect(Value.Check(ResponseMetaSchema, value)).toBe(false);
    });

    it("rejects LocalResponseMeta missing operationId", () => {
      const value = { source: "local", timestamp: Date.now() };
      expect(Value.Check(ResponseMetaSchema, value)).toBe(false);
    });

    it("rejects HTTPResponseMeta missing statusCode", () => {
      const value = { source: "http", headers: {}, contentType: "text/plain" };
      expect(Value.Check(ResponseMetaSchema, value)).toBe(false);
    });

    it("rejects MCPResponseMeta missing content", () => {
      const value = { source: "mcp", isError: false };
      expect(Value.Check(ResponseMetaSchema, value)).toBe(false);
    });

    it("rejects MCPResponseMeta with isError as string", () => {
      const value = { source: "mcp", isError: "yes", content: [] };
      expect(Value.Check(ResponseMetaSchema, value)).toBe(false);
    });
  });

  describe("MCPContentBlockSchema (via MCPResponseMeta validation)", () => {
    it("validates text content block", () => {
      const meta: MCPResponseMeta = {
        source: "mcp",
        isError: false,
        content: [{ type: "text", text: "hello world" }],
      };
      expect(Value.Check(ResponseMetaSchema, meta)).toBe(true);
    });

    it("validates text content block with annotations", () => {
      const annotations: MCPAnnotations = { audience: ["user"], priority: 1 };
      const meta: MCPResponseMeta = {
        source: "mcp",
        isError: false,
        content: [{ type: "text", text: "hello", annotations }],
      };
      expect(Value.Check(ResponseMetaSchema, meta)).toBe(true);
    });

    it("validates image content block", () => {
      const meta: MCPResponseMeta = {
        source: "mcp",
        isError: false,
        content: [{ type: "image", data: "base64data", mimeType: "image/png" }],
      };
      expect(Value.Check(ResponseMetaSchema, meta)).toBe(true);
    });

    it("validates audio content block", () => {
      const meta: MCPResponseMeta = {
        source: "mcp",
        isError: false,
        content: [{ type: "audio", data: "base64audio", mimeType: "audio/wav" }],
      };
      expect(Value.Check(ResponseMetaSchema, meta)).toBe(true);
    });

    it("validates resource content block", () => {
      const resource: MCPResourceContent = { uri: "file:///test.txt", text: "content" };
      const meta: MCPResponseMeta = {
        source: "mcp",
        isError: false,
        content: [{ type: "resource", resource }],
      };
      expect(Value.Check(ResponseMetaSchema, meta)).toBe(true);
    });

    it("validates resource_link content block", () => {
      const meta: MCPResponseMeta = {
        source: "mcp",
        isError: false,
        content: [{ type: "resource_link", uri: "file:///doc.pdf", name: "document.pdf" }],
      };
      expect(Value.Check(ResponseMetaSchema, meta)).toBe(true);
    });

    it("validates resource_link with optional fields", () => {
      const meta: MCPResponseMeta = {
        source: "mcp",
        isError: false,
        content: [{ type: "resource_link", uri: "file:///doc.pdf", name: "doc", description: "A doc", mimeType: "application/pdf" }],
      };
      expect(Value.Check(ResponseMetaSchema, meta)).toBe(true);
    });

    it("rejects content block with unknown type", () => {
      const meta = {
        source: "mcp",
        isError: false,
        content: [{ type: "video", data: "base64video" }],
      };
      expect(Value.Check(ResponseMetaSchema, meta)).toBe(false);
    });

    it("rejects text content block missing text field", () => {
      const meta = {
        source: "mcp",
        isError: false,
        content: [{ type: "text" }],
      };
      expect(Value.Check(ResponseMetaSchema, meta)).toBe(false);
    });
  });
});