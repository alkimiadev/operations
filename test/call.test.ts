import { describe, it, expect, vi } from "vitest";
import { PendingRequestMap, buildCallHandler } from "../src/call.js";
import { CallError, InfrastructureErrorCode } from "../src/error.js";
import { OperationRegistry } from "../src/registry.js";
import { Type } from "@alkdev/typebox";
import { OperationType } from "../src/types.js";
import type { Identity } from "../src/types.js";
import { localEnvelope, httpEnvelope, mcpEnvelope, isResponseEnvelope } from "../src/response-envelope.js";
import type { ResponseEnvelope } from "../src/response-envelope.js";

describe("PendingRequestMap", () => {
  it("creates instance without event target", () => {
    const map = new PendingRequestMap();
    expect(map.getPendingCount()).toBe(0);
  });

  it("creates instance with event target", () => {
    const target = new EventTarget();
    const map = new PendingRequestMap(target);
    expect(map.getPendingCount()).toBe(0);
  });

  it("call() resolves when respond() is called with a ResponseEnvelope", async () => {
    const map = new PendingRequestMap();

    const callPromise = map.call("test.op", { value: "hello" });

    setTimeout(() => {
      const requestId = [...map["requests"].keys()][0];
      map.respond(requestId, localEnvelope({ result: "world" }, "test.op"));
    }, 10);

    const result = await callPromise;
    expect(isResponseEnvelope(result)).toBe(true);
    expect(result.meta.source).toBe("local");
    expect(result.data).toEqual({ result: "world" });
  });

  it("call() resolves with the full ResponseEnvelope", async () => {
    const map = new PendingRequestMap();

    const callPromise = map.call("test.op", { value: "hello" });

    const envelope = httpEnvelope({ status: "ok" }, {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      contentType: "application/json",
    });

    setTimeout(() => {
      const requestId = [...map["requests"].keys()][0];
      map.respond(requestId, envelope);
    }, 10);

    const result = await callPromise;
    expect(result.meta.source).toBe("http");
    expect(result.data).toEqual({ status: "ok" });
    if (result.meta.source === "http") {
      expect(result.meta.statusCode).toBe(200);
    }
  });

  it("respond() throws when called with non-envelope value", () => {
    const map = new PendingRequestMap();
    expect(() => map.respond("req-1", { result: "world" } as any)).toThrow("ResponseEnvelope");
  });

  it("call() rejects when emitError() is called", async () => {
    const map = new PendingRequestMap();

    const callPromise = map.call("test.op", { value: "hello" });

    setTimeout(() => {
      const requestId = [...map["requests"].keys()][0];
      map.emitError(requestId, "CUSTOM_ERROR", "Something went wrong");
    }, 10);

    await expect(callPromise).rejects.toThrow("Something went wrong");
    await expect(callPromise).rejects.toBeInstanceOf(CallError);
  });

  it("abort() rejects the pending call", async () => {
    const map = new PendingRequestMap();

    const callPromise = map.call("test.op", { value: "hello" });

    setTimeout(() => {
      const requestId = [...map["requests"].keys()][0];
      map.abort(requestId);
    }, 10);

    await expect(callPromise).rejects.toThrow("was aborted");
    await expect(callPromise).rejects.toBeInstanceOf(CallError);
  });

  it("call() with deadline times out", async () => {
    const map = new PendingRequestMap();

    const deadline = Date.now() + 50;
    const callPromise = map.call("test.op", { value: "hello" }, { deadline });

    await expect(callPromise).rejects.toThrow("timed out");
    await expect(callPromise).rejects.toBeInstanceOf(CallError);
  });

  it("tracks pending requests", () => {
    const map = new PendingRequestMap();
    map.call("test.op1", {});
    map.call("test.op2", {});
    expect(map.getPendingCount()).toBe(2);
  });

  it("cleans up after call resolves", async () => {
    const map = new PendingRequestMap();
    const callPromise = map.call("test.op", { value: "hello" });
    expect(map.getPendingCount()).toBe(1);

    const requestId = [...map["requests"].keys()][0];
    map.respond(requestId, localEnvelope({ result: "done" }, "test.op"));

    await callPromise;
    expect(map.getPendingCount()).toBe(0);
  });

  it("respond() throws when called with a non-envelope value", () => {
    const map = new PendingRequestMap();
    expect(() => map.respond("r1", { result: "raw" } as any)).toThrow(
      "PendingRequestMap.respond() requires a ResponseEnvelope"
    );
  });

  it("respond() throws when called with a null value", () => {
    const map = new PendingRequestMap();
    expect(() => map.respond("r1", null as any)).toThrow(
      "PendingRequestMap.respond() requires a ResponseEnvelope"
    );
  });

  it("respond() throws when called with a string value", () => {
    const map = new PendingRequestMap();
    expect(() => map.respond("r1", "raw string" as any)).toThrow(
      "PendingRequestMap.respond() requires a ResponseEnvelope"
    );
  });

  it("respond() accepts a localEnvelope", () => {
    const map = new PendingRequestMap();
    const callPromise = map.call("test.op", {});
    const requestId = [...map["requests"].keys()][0];

    expect(() => map.respond(requestId, localEnvelope("data", "test.op"))).not.toThrow();
  });

  it("respond() accepts an httpEnvelope", () => {
    const map = new PendingRequestMap();
    const callPromise = map.call("test.op", {});
    const requestId = [...map["requests"].keys()][0];

    expect(() => map.respond(requestId, httpEnvelope("data", {
      statusCode: 200,
      headers: {},
      contentType: "text/plain",
    }))).not.toThrow();
  });

  it("respond() accepts an mcpEnvelope", () => {
    const map = new PendingRequestMap();
    const callPromise = map.call("test.op", {});
    const requestId = [...map["requests"].keys()][0];

    expect(() => map.respond(requestId, mcpEnvelope("data", {
      isError: false,
      content: [],
    }))).not.toThrow();
  });

  it("call() returns Promise<ResponseEnvelope>", async () => {
    const map = new PendingRequestMap();

    const callPromise = map.call("test.op", { value: "hello" });

    setTimeout(() => {
      const requestId = [...map["requests"].keys()][0];
      map.respond(requestId, localEnvelope(42, "test.op"));
    }, 10);

    const result = await callPromise;
    expect(isResponseEnvelope(result)).toBe(true);
    expect(result.data).toBe(42);
    expect(result.meta.source).toBe("local");
  });
});

describe("CallHandler", () => {
  function makeRegistry(ops?: Array<Record<string, unknown>>) {
    const registry = new OperationRegistry();
    registry.register({
      name: "echo",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "echo op",
      inputSchema: Type.Object({ value: Type.String() }),
      outputSchema: Type.Object({ value: Type.String() }),
      accessControl: { requiredScopes: [] },
      handler: async (input: unknown) => ({ value: (input as { value: string }).value }),
    });
    registry.register({
      name: "voidOp",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "void op",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      accessControl: { requiredScopes: [] },
      handler: async () => undefined,
    });
    registry.register({
      name: "guarded",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "guarded op",
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ ok: Type.Boolean() }),
      accessControl: {
        requiredScopes: [],
        resourceType: "project",
        resourceAction: "read",
      },
      handler: async () => ({ ok: true }),
    });
    registry.register({
      name: "open",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "open op",
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ ok: Type.Boolean() }),
      accessControl: { requiredScopes: [] },
      handler: async () => ({ ok: true }),
    });

    if (ops) {
      for (const op of ops) {
        registry.register(op as any);
      }
    }
    return registry;
  }

  it("wraps handler return value in localEnvelope and publishes call.responded", async () => {
    const registry = makeRegistry();
    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const callPromise = callMap.call("test.echo", { value: "hello" });

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.echo",
      input: { value: "hello" },
    });

    const result = await callPromise;
    expect(result.meta.source).toBe("local");
    if (result.meta.source === "local") {
      expect(result.meta.operationId).toBe("test.echo");
      expect(typeof result.meta.timestamp).toBe("number");
    }
    expect(result.data).toEqual({ value: "hello" });
  });

  it("wraps undefined handler return value and publishes call.responded", async () => {
    const registry = makeRegistry();
    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const callPromise = callMap.call("test.voidOp", {});

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.voidOp",
      input: {},
    });

    const result = await callPromise;
    expect(result.meta.source).toBe("local");
    if (result.meta.source === "local") {
      expect(result.meta.operationId).toBe("test.voidOp");
    }
    expect(result.data).toBeUndefined();
  });

  it("passes through a pre-built ResponseEnvelope from handler", async () => {
    const registry = new OperationRegistry();
    const mcpResult = mcpEnvelope({ structured: true }, {
      isError: false,
      content: [{ type: "text" as const, text: "result" }],
      structuredContent: { structured: true },
    });
    registry.register({
      name: "mcpOp",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "mcp op",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      accessControl: { requiredScopes: [] },
      handler: async () => mcpResult,
    });

    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const callPromise = callMap.call("test.mcpOp", {});

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.mcpOp",
      input: {},
    });

    const result = await callPromise;
    expect(result.meta.source).toBe("mcp");
    expect(result.data).toEqual({ structured: true });
  });

  it("passes through httpEnvelope from handler", async () => {
    const registry = new OperationRegistry();
    const httpResult = httpEnvelope({ items: [1, 2, 3] }, {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      contentType: "application/json",
    });
    registry.register({
      name: "httpOp",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "http op",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      accessControl: { requiredScopes: [] },
      handler: async () => httpResult,
    });

    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const callPromise = callMap.call("test.httpOp", {});

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.httpOp",
      input: {},
    });

    const result = await callPromise;
    expect(result.meta.source).toBe("http");
    if (result.meta.source === "http") {
      expect(result.meta.statusCode).toBe(200);
    }
    expect(result.data).toEqual({ items: [1, 2, 3] });
  });

  it("publishes call.error when handler throws", async () => {
    const registry = new OperationRegistry();
    registry.register({
      name: "throws",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "throws op",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      accessControl: { requiredScopes: [] },
      handler: async () => { throw new Error("handler failed"); },
    });

    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const callPromise = callMap.call("test.throws", {});

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.throws",
      input: {},
    });

    await expect(callPromise).rejects.toThrow("handler failed");
  });

  it("publishes call.error with CallError when handler throws CallError", async () => {
    const registry = new OperationRegistry();
    registry.register({
      name: "throwsCallError",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "throws call error",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      accessControl: { requiredScopes: [] },
      handler: async () => {
        throw new CallError("CUSTOM_CODE", "custom error message", { detail: "info" });
      },
    });

    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const callPromise = callMap.call("test.throwsCallError", {});

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.throwsCallError",
      input: {},
    });

    try {
      await callPromise;
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe("CUSTOM_CODE");
      expect((error as CallError).message).toBe("custom error message");
    }
  });

  it("publishes call.error when operation not found", async () => {
    const registry = new OperationRegistry();
    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const callPromise = callMap.call("test.nonexistent", {});

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.nonexistent",
      input: {},
    });

    try {
      await callPromise;
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.OPERATION_NOT_FOUND);
    }
  });

  it("publishes call.error when handler not registered", async () => {
    const registry = new OperationRegistry();
    registry.registerSpec({
      name: "noHandler",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "op without handler",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      accessControl: { requiredScopes: [] },
    });

    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const callPromise = callMap.call("test.noHandler", {});

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.noHandler",
      input: {},
    });

    try {
      await callPromise;
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.OPERATION_NOT_FOUND);
    }
  });

  it("publishes call.error on access denied", async () => {
    const registry = makeRegistry();
    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const identity: Identity = { id: "user1", scopes: [] };

    const callPromise = callMap.call("test.guarded", {}, { identity });

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.guarded",
      input: {},
      identity,
    });

    try {
      await callPromise;
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.ACCESS_DENIED);
    }
  });

  it("publishes call.error for unknown operations with mapError defaults", async () => {
    const registry = new OperationRegistry();
    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const callPromise = callMap.call("test.nonexistent", {});

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.nonexistent",
      input: {},
    });

    try {
      await callPromise;
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.OPERATION_NOT_FOUND);
    }
  });

  it("applies Value.Cast normalization via execute()", async () => {
    const registry = new OperationRegistry();
    registry.register({
      name: "defaultsFields",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "op with default fields",
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ name: Type.String(), count: Type.Number({ default: 0 }) }),
      accessControl: { requiredScopes: [] },
      handler: async () => ({ name: "test" }),
    });

    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const callPromise = callMap.call("test.defaultsFields", {});

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.defaultsFields",
      input: {},
    });

    const result = await callPromise;
    expect(result.data).toEqual({ name: "test", count: 0 });
  });

  it("does not normalize with Value.Cast when outputSchema is Unknown", async () => {
    const registry = new OperationRegistry();
    registry.register({
      name: "unknownOutput",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "op with unknown output",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      accessControl: { requiredScopes: [] },
      handler: async () => ({ name: "test", extra: "field" }),
    });

    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const callPromise = callMap.call("test.unknownOutput", {});

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.unknownOutput",
      input: {},
    });

    const result = await callPromise;
    expect(result.data).toEqual({ name: "test", extra: "field" });
  });

  it("maps errors using spec errorSchemas", async () => {
    const registry = new OperationRegistry();
    registry.register({
      name: "customError",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "op with custom errors",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      accessControl: { requiredScopes: [] },
      errorSchemas: [
        { code: "NOT_FOUND", description: "Item not found", schema: Type.Object({ id: Type.String() }) },
      ],
      handler: async () => { throw new Error("NOT_FOUND: item 42"); },
    });

    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const callPromise = callMap.call("test.customError", {});

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.customError",
      input: {},
    });

    try {
      await callPromise;
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe("NOT_FOUND");
      expect((error as CallError).message).toBe("NOT_FOUND: item 42");
    }
  });
});

describe("checkAccess resource access control", () => {
  function makeRegistry(accessControlOverrides: Record<string, unknown> = {}) {
    const registry = new OperationRegistry();
    registry.register({
      name: "guarded",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "guarded op",
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ ok: Type.Boolean() }),
      accessControl: {
        requiredScopes: [],
        resourceType: "project",
        resourceAction: "read",
        ...accessControlOverrides,
      },
      handler: async () => ({ ok: true }),
    });
    registry.register({
      name: "open",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "open op",
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ ok: Type.Boolean() }),
      accessControl: {
        requiredScopes: [],
      },
      handler: async () => ({ ok: true }),
    });
    return registry;
  }

  it("denies access when resourceType/resourceAction are set and identity.resources is undefined", async () => {
    const registry = makeRegistry();
    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const identity: Identity = { id: "user1", scopes: [] };

    const callPromise = callMap.call("test.guarded", {}, { identity });

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.guarded",
      input: {},
      identity,
    });

    try {
      await callPromise;
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.ACCESS_DENIED);
    }
  });

  it("denies access when resourceType/resourceAction are set and identity.resources is empty", async () => {
    const registry = makeRegistry();
    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const identity: Identity = { id: "user1", scopes: [], resources: {} };

    const callPromise = callMap.call("test.guarded", {}, { identity });

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.guarded",
      input: {},
      identity,
    });

    try {
      await callPromise;
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.ACCESS_DENIED);
    }
  });

  it("denies access when identity.resources has no matching resource type", async () => {
    const registry = makeRegistry();
    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const identity: Identity = {
      id: "user1",
      scopes: [],
      resources: { "document:abc": ["read"] },
    };

    const callPromise = callMap.call("test.guarded", {}, { identity });

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.guarded",
      input: {},
      identity,
    });

    try {
      await callPromise;
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.ACCESS_DENIED);
    }
  });

  it("denies access when identity.resources has matching type but wrong action", async () => {
    const registry = makeRegistry();
    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const identity: Identity = {
      id: "user1",
      scopes: [],
      resources: { "project:abc": ["write"] },
    };

    const callPromise = callMap.call("test.guarded", {}, { identity });

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.guarded",
      input: {},
      identity,
    });

    try {
      await callPromise;
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.ACCESS_DENIED);
    }
  });

  it("grants access when identity.resources has matching type and action", async () => {
    const registry = makeRegistry();
    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const identity: Identity = {
      id: "user1",
      scopes: [],
      resources: { "project:abc": ["read"] },
    };

    const callPromise = callMap.call("test.guarded", {}, { identity });

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.guarded",
      input: {},
      identity,
    });

    const result = await callPromise;
    expect(result.data).toEqual({ ok: true });
  });

  it("grants access when neither resourceType nor resourceAction are set", async () => {
    const registry = makeRegistry();
    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const identity: Identity = { id: "user1", scopes: [] };

    const callPromise = callMap.call("test.open", {}, { identity });

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.open",
      input: {},
      identity,
    });

    const result = await callPromise;
    expect(result.data).toEqual({ ok: true });
  });

  it("grants access when identity.resources matches and identity has no scopes required", async () => {
    const registry = makeRegistry();
    const callMap = new PendingRequestMap();
    const handler = buildCallHandler({ registry, callMap });

    const identity: Identity = {
      id: "user1",
      scopes: ["some:scope"],
      resources: { "project:xyz": ["read", "write"] },
    };

    const callPromise = callMap.call("test.guarded", {}, { identity });

    await handler({
      requestId: [...callMap["requests"].keys()][0],
      operationId: "test.guarded",
      input: {},
      identity,
    });

    const result = await callPromise;
    expect(result.data).toEqual({ ok: true });
  });
});