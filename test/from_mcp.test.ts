import { describe, it, expect } from "vitest";
import { Type } from "@alkdev/typebox";
import { Value } from "@alkdev/typebox/value";
import { mapMCPContentBlocks } from "../src/from_mcp.js";
import { isResponseEnvelope } from "../src/response-envelope.js";
import type { MCPContentBlock } from "../src/response-envelope.js";

describe("mapMCPContentBlocks", () => {
  it("maps text content blocks", () => {
    const sdkBlocks = [
      { type: "text", text: "hello world" },
    ];
    const result = mapMCPContentBlocks(sdkBlocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "text", text: "hello world" });
  });

  it("maps text content blocks with annotations", () => {
    const sdkBlocks = [
      { type: "text", text: "hello", annotations: { audience: ["user"], priority: 1 } },
    ];
    const result = mapMCPContentBlocks(sdkBlocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "text",
      text: "hello",
      annotations: { audience: ["user"], priority: 1 },
    });
  });

  it("maps image content blocks", () => {
    const sdkBlocks = [
      { type: "image", data: "base64data", mimeType: "image/png" },
    ];
    const result = mapMCPContentBlocks(sdkBlocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "image",
      data: "base64data",
      mimeType: "image/png",
    });
  });

  it("maps audio content blocks", () => {
    const sdkBlocks = [
      { type: "audio", data: "base64audio", mimeType: "audio/wav" },
    ];
    const result = mapMCPContentBlocks(sdkBlocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "audio",
      data: "base64audio",
      mimeType: "audio/wav",
    });
  });

  it("maps resource content blocks", () => {
    const sdkBlocks = [
      {
        type: "resource",
        resource: {
          uri: "file:///test.txt",
          mimeType: "text/plain",
          text: "file content",
        },
      },
    ];
    const result = mapMCPContentBlocks(sdkBlocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "resource",
      resource: {
        uri: "file:///test.txt",
        mimeType: "text/plain",
        text: "file content",
      },
    });
  });

  it("maps resource_link content blocks", () => {
    const sdkBlocks = [
      {
        type: "resource_link",
        uri: "file:///data.json",
        name: "data",
        description: "A data file",
        mimeType: "application/json",
      },
    ];
    const result = mapMCPContentBlocks(sdkBlocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "resource_link",
      uri: "file:///data.json",
      name: "data",
      description: "A data file",
      mimeType: "application/json",
    });
  });

  it("maps resource_link content blocks without optional fields", () => {
    const sdkBlocks = [
      {
        type: "resource_link",
        uri: "file:///data.json",
        name: "data",
      },
    ];
    const result = mapMCPContentBlocks(sdkBlocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "resource_link",
      uri: "file:///data.json",
      name: "data",
    });
    expect(result[0]).not.toHaveProperty("description");
    expect(result[0]).not.toHaveProperty("mimeType");
  });

  it("falls back to text JSON.stringify for unknown block types", () => {
    const sdkBlocks = [
      { type: "custom_type", foo: "bar", baz: 42 },
    ];
    const result = mapMCPContentBlocks(sdkBlocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "text",
      text: JSON.stringify({ type: "custom_type", foo: "bar", baz: 42 }),
    });
  });

  it("falls back to text JSON.stringify for non-object blocks", () => {
    const result = mapMCPContentBlocks([null, 42, "hello", true]);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ type: "text", text: "null" });
    expect(result[1]).toEqual({ type: "text", text: "42" });
    expect(result[2]).toEqual({ type: "text", text: "\"hello\"" });
    expect(result[3]).toEqual({ type: "text", text: "true" });
  });

  it("handles multiple mixed content blocks", () => {
    const sdkBlocks = [
      { type: "text", text: "result" },
      { type: "image", data: "abc", mimeType: "image/png" },
      { type: "resource", resource: { uri: "f.txt", text: "hi" } },
    ];
    const result = mapMCPContentBlocks(sdkBlocks);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("text");
    expect(result[1].type).toBe("image");
    expect(result[2].type).toBe("resource");
  });

  it("handles empty array", () => {
    const result = mapMCPContentBlocks([]);
    expect(result).toEqual([]);
  });

  it("maps resource blocks with blob instead of text", () => {
    const sdkBlocks = [
      {
        type: "resource",
        resource: {
          uri: "file:///binary.bin",
          mimeType: "application/octet-stream",
          blob: "base64blob",
        },
      },
    ];
    const result = mapMCPContentBlocks(sdkBlocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "resource",
      resource: {
        uri: "file:///binary.bin",
        mimeType: "application/octet-stream",
        blob: "base64blob",
      },
    });
  });

  it("maps image content blocks with annotations", () => {
    const sdkBlocks = [
      { type: "image", data: "base64data", mimeType: "image/png", annotations: { priority: 5 } },
    ];
    const result = mapMCPContentBlocks(sdkBlocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "image",
      data: "base64data",
      mimeType: "image/png",
      annotations: { priority: 5 },
    });
  });

  it("maps audio content blocks with annotations", () => {
    const sdkBlocks = [
      { type: "audio", data: "base64audio", mimeType: "audio/wav", annotations: { audience: ["assistant"] } },
    ];
    const result = mapMCPContentBlocks(sdkBlocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "audio",
      data: "base64audio",
      mimeType: "audio/wav",
      annotations: { audience: ["assistant"] },
    });
  });

  it("maps resource content blocks with annotations", () => {
    const sdkBlocks = [
      {
        type: "resource",
        resource: { uri: "file:///test.txt", text: "hi" },
        annotations: { priority: 1 },
      },
    ];
    const result = mapMCPContentBlocks(sdkBlocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "resource",
      resource: { uri: "file:///test.txt", text: "hi" },
      annotations: { priority: 1 },
    });
  });
});

describe("MCP handler envelope wrapping (unit)", () => {
  it("isResponseEnvelope detects mcpEnvelope results", () => {
    const envelope = {
      data: [{ type: "text" as const, text: "result" }],
      meta: {
        source: "mcp" as const,
        isError: false,
        content: [{ type: "text" as const, text: "result" }],
      },
    };
    expect(isResponseEnvelope(envelope)).toBe(true);
  });

  it("isResponseEnvelope detects mcpEnvelope with isError: true", () => {
    const envelope = {
      data: [{ type: "text" as const, text: "error details" }],
      meta: {
        source: "mcp" as const,
        isError: true,
        content: [{ type: "text" as const, text: "error details" }],
      },
    };
    expect(isResponseEnvelope(envelope)).toBe(true);
  });

  it("Value.Cast normalizes structuredContent against outputSchema", () => {
    const outputSchema = Type.Object({
      name: Type.String(),
      count: Type.Number(),
    });

    const structuredContent = { name: "test", count: 42, extra: "removed" };
    const cast = Value.Cast(outputSchema, structuredContent);

    expect(cast.name).toBe("test");
    expect(cast.count).toBe(42);
  });

  it("Value.Cast with Type.Unknown passes through any value", () => {
    const unknownSchema = Type.Unknown();
    const data = { anything: "goes", nested: [1, 2, 3] };
    const cast = Value.Cast(unknownSchema, data);
    expect(cast).toEqual(data);
  });

  it("isResponseEnvelope rejects non-envelope values", () => {
    expect(isResponseEnvelope(null)).toBe(false);
    expect(isResponseEnvelope(undefined)).toBe(false);
    expect(isResponseEnvelope("string")).toBe(false);
    expect(isResponseEnvelope({})).toBe(false);
    expect(isResponseEnvelope({ data: "test" })).toBe(false);
    expect(isResponseEnvelope({ meta: { source: "mcp" } })).toBe(false);
  });
});