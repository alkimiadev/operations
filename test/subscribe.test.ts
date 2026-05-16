import { describe, it, expect } from "vitest";
import { subscribe } from "../src/subscribe.js";
import { OperationRegistry } from "../src/registry.js";
import { Type } from "@alkdev/typebox";
import { OperationType } from "../src/types.js";
import type { OperationContext } from "../src/types.js";
import { localEnvelope, httpEnvelope, mcpEnvelope, isResponseEnvelope } from "../src/response-envelope.js";
import type { ResponseEnvelope, LocalResponseMeta } from "../src/response-envelope.js";
import { CallError, InfrastructureErrorCode } from "../src/error.js";

function makeContext(overrides: Partial<OperationContext> = {}): OperationContext {
  return { requestId: "test-req-1", ...overrides };
}

function makeRegistry(
  operationId: string,
  handler: (input: unknown, context: OperationContext) => AsyncGenerator<unknown, void, unknown>,
) {
  const [namespace, name] = operationId.split(".");
  const registry = new OperationRegistry();
  registry.register({
    name,
    namespace,
    version: "1.0.0",
    type: OperationType.SUBSCRIPTION,
    description: `Test subscription ${operationId}`,
    inputSchema: Type.Object({}),
    outputSchema: Type.Unknown(),
    accessControl: { requiredScopes: [] },
    handler,
  });
  return registry;
}

describe("subscribe", () => {
  it("wraps raw yielded values in ResponseEnvelope with local source", async () => {
    async function* handler(_input: unknown, _context: OperationContext) {
      yield "event1";
      yield "event2";
    }

    const registry = makeRegistry("test.stream", handler);
    const results: ResponseEnvelope[] = [];

    for await (const envelope of subscribe(registry, "test.stream", {}, makeContext())) {
      results.push(envelope);
    }

    expect(results).toHaveLength(2);
    expect(results[0].data).toBe("event1");
    expect(results[0].meta.source).toBe("local");
    const meta0 = results[0].meta as LocalResponseMeta;
    expect(meta0.operationId).toBe("test.stream");
    expect(typeof meta0.timestamp).toBe("number");
    expect(results[1].data).toBe("event2");
    expect(results[1].meta.source).toBe("local");
    const meta1 = results[1].meta as LocalResponseMeta;
    expect(meta1.operationId).toBe("test.stream");
  });

  it("passes through pre-built ResponseEnvelope values without re-wrapping", async () => {
    const preBuilt = httpEnvelope({ status: "ok" }, {
      statusCode: 200,
      headers: {},
      contentType: "application/json",
    });

    async function* handler(_input: unknown, _context: OperationContext) {
      yield preBuilt;
    }

    const registry = makeRegistry("test.httpStream", handler);
    const results: ResponseEnvelope[] = [];

    for await (const envelope of subscribe(registry, "test.httpStream", {}, makeContext())) {
      results.push(envelope);
    }

    expect(results).toHaveLength(1);
    expect(results[0]).toBe(preBuilt);
    expect(results[0].meta.source).toBe("http");
    expect(results[0].data).toEqual({ status: "ok" });
  });

  it("passes through MCP envelope values without re-wrapping", async () => {
    const mcpEnv = mcpEnvelope({ temp: 72 }, {
      isError: false,
      content: [{ type: "text", text: "Temperature is 72" }],
    });

    async function* handler(_input: unknown, _context: OperationContext) {
      yield mcpEnv;
    }

    const registry = makeRegistry("test.mcpStream", handler);
    const results: ResponseEnvelope[] = [];

    for await (const envelope of subscribe(registry, "test.mcpStream", {}, makeContext())) {
      results.push(envelope);
    }

    expect(results).toHaveLength(1);
    expect(results[0]).toBe(mcpEnv);
    expect(results[0].meta.source).toBe("mcp");
  });

  it("sets a fresh timestamp per yield", async () => {
    async function* handler(_input: unknown, _context: OperationContext) {
      yield "a";
      yield "b";
      yield "c";
    }

    const registry = makeRegistry("test.timestamped", handler);
    const results: ResponseEnvelope[] = [];

    for await (const envelope of subscribe(registry, "test.timestamped", {}, makeContext())) {
      results.push(envelope);
    }

    expect(results).toHaveLength(3);
    const timestamps = results.map((e) => (e.meta as { timestamp: number }).timestamp);
    expect(timestamps[0]).toBeLessThanOrEqual(timestamps[1]);
    expect(timestamps[1]).toBeLessThanOrEqual(timestamps[2]);
  });

  it("returns AsyncGenerator<ResponseEnvelope, void, unknown>", async () => {
    async function* handler(_input: unknown, _context: OperationContext) {
      yield 42;
    }

    const registry = makeRegistry("test.typecheck", handler);
    const gen = subscribe(registry, "test.typecheck", {}, makeContext());

    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(isResponseEnvelope(first.value)).toBe(true);

    const done = await gen.next();
    expect(done.done).toBe(true);
  });

  it("throws CallError when operation spec not found", async () => {
    const registry = new OperationRegistry();

    try {
      for await (const _ of subscribe(registry, "nonexistent.op", {}, makeContext())) {
        // should not reach here
      }
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.OPERATION_NOT_FOUND);
    }
  });

  it("throws CallError when handler not registered", async () => {
    const registry = new OperationRegistry();
    registry.registerSpec({
      name: "unhandled",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.SUBSCRIPTION,
      description: "No handler",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      accessControl: { requiredScopes: [] },
    });

    try {
      for await (const _ of subscribe(registry, "test.unhandled", {}, makeContext())) {
        // should not reach here
      }
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.OPERATION_NOT_FOUND);
    }
  });

  it("handles generator that yields nothing", async () => {
    async function* handler(_input: unknown, _context: OperationContext) {
      // yields nothing
    }

    const registry = makeRegistry("test.empty", handler);
    const results: ResponseEnvelope[] = [];

    for await (const envelope of subscribe(registry, "test.empty", {}, makeContext())) {
      results.push(envelope);
    }

    expect(results).toHaveLength(0);
  });

  it("handles generator that yields object values", async () => {
    async function* handler(_input: unknown, _context: OperationContext) {
      yield { count: 1 };
      yield { count: 2 };
    }

    const registry = makeRegistry("test.objects", handler);
    const results: ResponseEnvelope[] = [];

    for await (const envelope of subscribe(registry, "test.objects", {}, makeContext())) {
      results.push(envelope);
    }

    expect(results).toHaveLength(2);
    expect(results[0].data).toEqual({ count: 1 });
    expect(results[1].data).toEqual({ count: 2 });
    expect((results[0].meta as LocalResponseMeta).operationId).toBe("test.objects");
  });

  it("handles generator that yields null values", async () => {
    async function* handler(_input: unknown, _context: OperationContext) {
      yield null;
    }

    const registry = makeRegistry("test.null", handler);
    const results: ResponseEnvelope[] = [];

    for await (const envelope of subscribe(registry, "test.null", {}, makeContext())) {
      results.push(envelope);
    }

    expect(results).toHaveLength(1);
    expect(results[0].data).toBeNull();
    expect(results[0].meta.source).toBe("local");
  });

  it("handles generator that yields local envelopes (pass-through)", async () => {
    const customEnv = localEnvelope({ custom: true }, "other.op");

    async function* handler(_input: unknown, _context: OperationContext) {
      yield customEnv;
    }

    const registry = makeRegistry("test.localPassthrough", handler);
    const results: ResponseEnvelope[] = [];

    for await (const envelope of subscribe(registry, "test.localPassthrough", {}, makeContext())) {
      results.push(envelope);
    }

    expect(results).toHaveLength(1);
    expect(results[0]).toBe(customEnv);
    expect((results[0].meta as LocalResponseMeta).operationId).toBe("other.op");
  });

  it("wraps mixed envelope and raw yields correctly", async () => {
    const httpEnv = httpEnvelope("http-data", {
      statusCode: 200,
      headers: {},
      contentType: "text/plain",
    });

    async function* handler(_input: unknown, _context: OperationContext) {
      yield "raw-value";
      yield httpEnv;
      yield 42;
    }

    const registry = makeRegistry("test.mixed", handler);
    const results: ResponseEnvelope[] = [];

    for await (const envelope of subscribe(registry, "test.mixed", {}, makeContext())) {
      results.push(envelope);
    }

    expect(results).toHaveLength(3);

    expect(results[0].data).toBe("raw-value");
    expect(results[0].meta.source).toBe("local");
    expect((results[0].meta as { operationId: string }).operationId).toBe("test.mixed");

    expect(results[1]).toBe(httpEnv);
    expect(results[1].meta.source).toBe("http");

    expect(results[2].data).toBe(42);
    expect(results[2].meta.source).toBe("local");
  });

  it("calls generator.return() in finally block on early termination", async () => {
    let returnCalled = false;

    async function* handler(_input: unknown, _context: OperationContext) {
      try {
        yield "event1";
        yield "event2";
        yield "event3";
      } finally {
        returnCalled = true;
      }
    }

    const registry = makeRegistry("test.early", handler);

    for await (const envelope of subscribe(registry, "test.early", {}, makeContext())) {
      expect(envelope.data).toBe("event1");
      break;
    }

    expect(returnCalled).toBe(true);
  });

  it("denies access when requiredScopes are set and no identity provided", async () => {
    const registry = new OperationRegistry();
    registry.register({
      name: "guardedSub",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.SUBSCRIPTION,
      description: "guarded sub",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      accessControl: { requiredScopes: ["admin"] },
      handler: async function* (_input: unknown, _context: OperationContext) {
        yield "should not reach";
      },
    });

    try {
      for await (const _ of subscribe(registry, "test.guardedSub", {}, makeContext())) {
        // should not reach here
      }
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.ACCESS_DENIED);
    }
  });

  it("grants access when identity has required scopes", async () => {
    const registry = new OperationRegistry();
    registry.register({
      name: "guardedSub",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.SUBSCRIPTION,
      description: "guarded sub",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      accessControl: { requiredScopes: ["read"] },
      handler: async function* (_input: unknown, _context: OperationContext) {
        yield "event1";
      },
    });

    const context = makeContext({ identity: { id: "user1", scopes: ["read"] } });
    const results: ResponseEnvelope[] = [];
    for await (const envelope of subscribe(registry, "test.guardedSub", {}, context)) {
      results.push(envelope);
    }
    expect(results).toHaveLength(1);
    expect(results[0].data).toBe("event1");
  });

  it("skips access control when context.trusted is true", async () => {
    const registry = new OperationRegistry();
    registry.register({
      name: "trustedSub",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.SUBSCRIPTION,
      description: "trusted sub",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      accessControl: { requiredScopes: ["admin"] },
      handler: async function* (_input: unknown, _context: OperationContext) {
        yield "secret-event";
      },
    });

    const context = makeContext({ trusted: true });
    const results: ResponseEnvelope[] = [];
    for await (const envelope of subscribe(registry, "test.trustedSub", {}, context)) {
      results.push(envelope);
    }
    expect(results).toHaveLength(1);
    expect(results[0].data).toBe("secret-event");
  });

  it("throws CallError when handler returns a non-async-iterable (plain async function)", async () => {
    const registry = new OperationRegistry();
    registry.registerSpec({
      name: "badSub",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.SUBSCRIPTION,
      description: "bad sub",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      accessControl: { requiredScopes: [] },
    });
    const plainAsyncFn = async (_input: unknown, _context: OperationContext) => "not a generator";
    (registry as any).handlers.set("test.badSub", plainAsyncFn);

    try {
      for await (const _ of subscribe(registry, "test.badSub", {}, makeContext())) {
        expect.fail("Should have thrown");
      }
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.EXECUTION_ERROR);
      expect((error as CallError).message).toContain("must return an async iterable");
    }
  });

  it("throws CallError when handler returns null", async () => {
    const registry = new OperationRegistry();
    registry.registerSpec({
      name: "nullSub",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.SUBSCRIPTION,
      description: "null sub",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      accessControl: { requiredScopes: [] },
    });
    const nullFn = (_input: unknown, _context: OperationContext): any => null;
    (registry as any).handlers.set("test.nullSub", nullFn);

    try {
      for await (const _ of subscribe(registry, "test.nullSub", {}, makeContext())) {
        expect.fail("Should have thrown");
      }
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.EXECUTION_ERROR);
      expect((error as CallError).message).toContain("must return an async iterable");
    }
  });

  it("throws CallError when handler returns a plain object (non-iterable)", async () => {
    const registry = new OperationRegistry();
    registry.registerSpec({
      name: "objSub",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.SUBSCRIPTION,
      description: "obj sub",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      accessControl: { requiredScopes: [] },
    });
    const objFn = (_input: unknown, _context: OperationContext): any => ({ not: "iterable" });
    (registry as any).handlers.set("test.objSub", objFn);

    try {
      for await (const _ of subscribe(registry, "test.objSub", {}, makeContext())) {
        expect.fail("Should have thrown");
      }
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.EXECUTION_ERROR);
      expect((error as CallError).message).toContain("must return an async iterable");
    }
  });
});