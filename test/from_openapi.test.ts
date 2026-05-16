import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FromOpenAPI, parseSSEFrames } from "../src/from_openapi.js";
import { OperationType } from "../src/types.js";
import type { SubscriptionHandler } from "../src/types.js";
import { CallError } from "../src/error.js";
import { isResponseEnvelope } from "../src/response-envelope.js";
import { Value } from "@alkdev/typebox/value";

const simpleSpec = {
  openapi: "3.0.0",
  info: { title: "Test API", version: "1.0.0" },
  paths: {
    "/users": {
      get: {
        operationId: "listUsers",
        description: "List all users",
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    users: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        operationId: "createUser",
        description: "Create a user",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                },
                required: ["name"],
              },
            },
          },
        },
        responses: {
          "201": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/events": {
      get: {
        operationId: "streamEvents",
        description: "Stream events via SSE",
        responses: {
          "200": {
            content: {
              "text/event-stream": {
                schema: {
                  type: "object",
                  properties: {
                    event: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/users/{id}": {
      get: {
        operationId: "getUser",
        description: "Get user by ID",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { type: "object", properties: { name: { type: "string" } } },
              },
            },
          },
        },
      },
    },
  },
};

describe("FromOpenAPI", () => {
  const config = {
    namespace: "api",
    baseUrl: "https://api.example.com",
  };

  it("generates operations from OpenAPI spec", () => {
    const ops = FromOpenAPI(simpleSpec as any, config);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.map((o) => o.name)).toContain("listUsers");
    expect(ops.map((o) => o.name)).toContain("createUser");
    expect(ops.map((o) => o.name)).toContain("getUser");
  });

  it("sets namespace from config", () => {
    const ops = FromOpenAPI(simpleSpec as any, config);
    expect(ops.every((o) => o.namespace === "api")).toBe(true);
  });

  it("detects GET as QUERY type", () => {
    const ops = FromOpenAPI(simpleSpec as any, config);
    const listUsers = ops.find((o) => o.name === "listUsers")!;
    expect(listUsers.type).toBe(OperationType.QUERY);
  });

  it("detects POST as MUTATION type", () => {
    const ops = FromOpenAPI(simpleSpec as any, config);
    const createUser = ops.find((o) => o.name === "createUser")!;
    expect(createUser.type).toBe(OperationType.MUTATION);
  });

  it("detects text/event-stream as SUBSCRIPTION type", () => {
    const ops = FromOpenAPI(simpleSpec as any, config);
    const streamEvents = ops.find((o) => o.name === "streamEvents")!;
    expect(streamEvents.type).toBe(OperationType.SUBSCRIPTION);
  });

  it("generates valid TypeBox input schemas", () => {
    const ops = FromOpenAPI(simpleSpec as any, config);
    const getUser = ops.find((o) => o.name === "getUser")!;
    expect(Value.Check(getUser.inputSchema, { id: "123" })).toBe(true);
  });

  it("handles auth bearer config", () => {
    const authConfig = {
      namespace: "api",
      baseUrl: "https://api.example.com",
      auth: { type: "bearer" as const, token: "test-token" },
    };
    const ops = FromOpenAPI(simpleSpec as any, authConfig);
    expect(ops.length).toBeGreaterThan(0);
  });

  it("skips non-HTTP methods", () => {
    const ops = FromOpenAPI(simpleSpec as any, config);
    expect(ops.every((o) => o.name)).toBeTruthy();
  });

  it("handles $ref resolution", () => {
    const specWithRef = {
      openapi: "3.0.0",
      info: { title: "Test", version: "1.0.0" },
      paths: {
        "/items": {
          get: {
            operationId: "listItems",
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/ItemList" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          ItemList: {
            type: "object",
            properties: {
              items: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    };
    const ops = FromOpenAPI(specWithRef as any, config);
    expect(ops.length).toBe(1);
  });
});

describe("FromOpenAPI handler envelope behavior", () => {
  const config = {
    namespace: "api",
    baseUrl: "https://api.example.com",
  };

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns httpEnvelope with JSON response data", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "Content-Type": "application/json", "X-Custom": "value" }),
      json: async () => ({ users: ["alice", "bob"] }),
      text: async () => "",
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    const ops = FromOpenAPI(simpleSpec as any, config);
    const listUsers = ops.find((o) => o.name === "listUsers")!;
    const result = await listUsers.handler({}, {} as any);

    expect(isResponseEnvelope(result)).toBe(true);
    if (isResponseEnvelope(result)) {
      expect(result.meta.source).toBe("http");
      expect(result.data).toEqual({ users: ["alice", "bob"] });
      const meta = result.meta as { statusCode: number; headers: Record<string, string>; contentType: string };
      expect(meta.statusCode).toBe(200);
      expect(meta.contentType).toBe("application/json");
      expect(meta.headers).toHaveProperty("x-custom", "value");
    }
  });

  it("returns httpEnvelope with text response data", async () => {
    const textSpec = {
      openapi: "3.0.0",
      info: { title: "Test", version: "1.0.0" },
      paths: {
        "/readme": {
          get: {
            operationId: "getReadme",
            responses: {
              "200": {
                content: { "text/plain": { schema: { type: "string" } } },
              },
            },
          },
        },
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "Content-Type": "text/plain" }),
      json: async () => ({}),
      text: async () => "Hello, world!",
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    const ops = FromOpenAPI(textSpec as any, config);
    const getReadme = ops.find((o) => o.name === "getReadme")!;
    const result = await getReadme.handler({}, {} as any);

    expect(isResponseEnvelope(result)).toBe(true);
    if (isResponseEnvelope(result)) {
      expect(result.meta.source).toBe("http");
      expect(result.data).toBe("Hello, world!");
      const meta = result.meta as { statusCode: number; headers: Record<string, string>; contentType: string };
      expect(meta.statusCode).toBe(200);
      expect(meta.contentType).toBe("text/plain");
    }
  });

  it("returns httpEnvelope with arrayBuffer for binary responses", async () => {
    const binaryData = new Uint8Array([1, 2, 3, 4]).buffer;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "Content-Type": "application/octet-stream" }),
      json: async () => ({}),
      text: async () => "",
      arrayBuffer: async () => binaryData,
    });

    const ops = FromOpenAPI(simpleSpec as any, config);
    const listUsers = ops.find((o) => o.name === "listUsers")!;
    const result = await listUsers.handler({}, {} as any);

    expect(isResponseEnvelope(result)).toBe(true);
    if (isResponseEnvelope(result)) {
      expect(result.meta.source).toBe("http");
      expect(result.data).toBe(binaryData);
      const meta = result.meta as { statusCode: number; headers: Record<string, string>; contentType: string };
      expect(meta.contentType).toBe("application/octet-stream");
    }
  });

  it("throws CallError on HTTP error status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: new Headers(),
    });

    const ops = FromOpenAPI(simpleSpec as any, config);
    const getUser = ops.find((o) => o.name === "getUser")!;

    try {
      await getUser.handler({ id: "123" }, {} as any);
      expect.fail("Expected CallError to be thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe("EXECUTION_ERROR");
      expect((error as CallError).message).toContain("HTTP 404");
    }
  });

  it("throws CallError on 500 status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Headers(),
    });

    const ops = FromOpenAPI(simpleSpec as any, config);
    const listUsers = ops.find((o) => o.name === "listUsers")!;

    try {
      await listUsers.handler({}, {} as any);
      expect.fail("Expected CallError to be thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe("EXECUTION_ERROR");
      expect((error as CallError).message).toContain("HTTP 500");
    }
  });

  it("includes statusCode from response in envelope", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      statusText: "Created",
      headers: new Headers({ "Content-Type": "application/json" }),
      json: async () => ({ id: "abc" }),
      text: async () => "",
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    const ops = FromOpenAPI(simpleSpec as any, config);
    const createUser = ops.find((o) => o.name === "createUser")!;
    const result = await createUser.handler({ body: { name: "Alice" } }, {} as any);

    expect(isResponseEnvelope(result)).toBe(true);
    if (isResponseEnvelope(result)) {
      const meta = result.meta as { statusCode: number };
      expect(meta.statusCode).toBe(201);
    }
  });

  it("converts response headers to Record<string, string>", async () => {
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    headers.set("X-Request-Id", "req-123");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers,
      json: async () => ({ result: "ok" }),
      text: async () => "",
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    const ops = FromOpenAPI(simpleSpec as any, config);
    const listUsers = ops.find((o) => o.name === "listUsers")!;
    const result = await listUsers.handler({}, {} as any);

    expect(isResponseEnvelope(result)).toBe(true);
    if (isResponseEnvelope(result)) {
      const meta = result.meta as { headers: Record<string, string> };
      expect(meta.headers["content-type"]).toBe("application/json");
      expect(meta.headers["x-request-id"]).toBe("req-123");
    }
  });
});

describe("parseSSEFrames", () => {
  it("parses a simple SSE event", () => {
    const buffer = "data: hello\n\n";
    const { events, remaining } = parseSSEFrames(buffer);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("hello");
    expect(events[0].eventType).toBe("message");
  });

  it("parses multiple SSE events", () => {
    const buffer = "data: first\n\ndata: second\n\n";
    const { events } = parseSSEFrames(buffer);
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe("first");
    expect(events[1].data).toBe("second");
  });

  it("parses multi-line data fields (joined with \\n)", () => {
    const buffer = "data: line1\ndata: line2\n\n";
    const { events } = parseSSEFrames(buffer);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("line1\nline2");
  });

  it("parses event type field", () => {
    const buffer = "event: custom\ndata: payload\n\n";
    const { events } = parseSSEFrames(buffer);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("custom");
    expect(events[0].data).toBe("payload");
  });

  it("parses id field", () => {
    const buffer = "id: 42\ndata: payload\n\n";
    const { events } = parseSSEFrames(buffer);
    expect(events).toHaveLength(1);
    expect(events[0].lastEventId).toBe("42");
  });

  it("ignores comment lines (starting with :)", () => {
    const buffer = ": this is a comment\ndata: hello\n\n";
    const { events } = parseSSEFrames(buffer);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("hello");
  });

  it("handles CRLF line endings", () => {
    const buffer = "data: hello\r\n\r\n";
    const { events } = parseSSEFrames(buffer);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("hello");
  });

  it("handles CR line endings", () => {
    const buffer = "data: hello\r\r";
    const { events } = parseSSEFrames(buffer);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("hello");
  });

  it("strips BOM at stream start", () => {
    const buffer = "\uFEFFdata: hello\n\n";
    const { events } = parseSSEFrames(buffer);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("hello");
  });

  it("removes single leading space after data: per WHATWG spec", () => {
    const buffer = "data:  two spaces\n\n";
    const { events } = parseSSEFrames(buffer);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe(" two spaces");
  });

  it("handles partial lines (returns as remaining)", () => {
    const buffer = "data: incom";
    const { events, remaining } = parseSSEFrames(buffer);
    expect(events).toHaveLength(0);
    expect(remaining).toBe("data: incom");
  });

  it("handles empty data with empty line dispatch", () => {
    const buffer = "data:\n\n";
    const { events } = parseSSEFrames(buffer);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("");
  });

  it("skips events with no data lines (empty dispatch)", () => {
    const buffer = "event: ping\n\n";
    const { events } = parseSSEFrames(buffer);
    expect(events).toHaveLength(0);
  });
});

describe("FromOpenAPI SUBSCRIPTION handler", () => {
  const config = {
    namespace: "api",
    baseUrl: "https://api.example.com",
  };

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("generates SubscriptionHandler for SUBSCRIPTION type operations", () => {
    const ops = FromOpenAPI(simpleSpec as any, config);
    const streamEvents = ops.find((o) => o.name === "streamEvents")!;
    expect(streamEvents.type).toBe(OperationType.SUBSCRIPTION);
    expect(typeof streamEvents.handler).toBe("function");
  });

  it("SSE handler yields events as httpEnvelope", async () => {
    const sseStream = [
      "data: {\"event\":\"ping\"}\n\n",
      "data: {\"event\":\"pong\"}\n\n",
    ].join("");

    const encoder = new TextEncoder();
    const chunks = [encoder.encode(sseStream)];

    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: chunks[0] })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      releaseLock: vi.fn(),
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "Content-Type": "text/event-stream" }),
      body: { getReader: () => reader },
    });

    const ops = FromOpenAPI(simpleSpec as any, config);
    const streamEvents = ops.find((o) => o.name === "streamEvents")!;
    const handler = streamEvents.handler as SubscriptionHandler<unknown, unknown, unknown>;

    const results: unknown[] = [];
    for await (const value of handler({}, {} as any)) {
      results.push(value);
    }

    expect(results).toHaveLength(2);
    expect(isResponseEnvelope(results[0])).toBe(true);
    if (isResponseEnvelope(results[0])) {
      expect(results[0].meta.source).toBe("http");
      expect(results[0].data).toEqual({ event: "ping" });
      const meta = results[0].meta as { statusCode: number; contentType: string };
      expect(meta.statusCode).toBe(200);
      expect(meta.contentType).toBe("text/event-stream");
    }
    expect(isResponseEnvelope(results[1])).toBe(true);
    if (isResponseEnvelope(results[1])) {
      expect(results[1].data).toEqual({ event: "pong" });
    }
    expect(reader.releaseLock).toHaveBeenCalled();
  });

  it("SSE handler throws CallError on HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Headers(),
    });

    const ops = FromOpenAPI(simpleSpec as any, config);
    const streamEvents = ops.find((o) => o.name === "streamEvents")!;
    const handler = streamEvents.handler as SubscriptionHandler<unknown, unknown, unknown>;

    try {
      for await (const _ of handler({}, {} as any)) {
        // should not reach
      }
      expect.fail("Expected CallError");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe("EXECUTION_ERROR");
      expect((error as CallError).message).toContain("HTTP 500");
    }
  });
});