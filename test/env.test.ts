import { describe, it, expect, vi } from "vitest";
import { OperationRegistry, OperationType, buildEnv, type IOperationDefinition, type OperationContext } from "../src/index.js";
import * as Type from "@alkdev/typebox";
import { httpEnvelope, isResponseEnvelope, type ResponseEnvelope } from "../src/response-envelope.js";
import { CallError, InfrastructureErrorCode } from "../src/error.js";
import type { Identity } from "../src/types.js";

function makeOperation(name: string, handler?: any): IOperationDefinition {
  return {
    name,
    namespace: "test",
    version: "1.0.0",
    type: OperationType.QUERY,
    description: `Test ${name}`,
    inputSchema: Type.Object({ value: Type.String() }),
    outputSchema: Type.Object({ result: Type.String() }),
    accessControl: { requiredScopes: [] },
    handler: handler || (async (input: any) => ({ result: input.value })),
  };
}

describe("buildEnv", () => {
  it("creates namespace-keyed env", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation("readFile"));
    registry.register(makeOperation("writeFile"));

    const env = buildEnv({
      registry,
      context: {} as OperationContext,
    });

    expect(env.test).toBeDefined();
    expect(typeof env.test.readFile).toBe("function");
    expect(typeof env.test.writeFile).toBe("function");

    const result = await env.test.readFile({ value: "test" });
    expect(isResponseEnvelope(result)).toBe(true);
    expect(result.meta.source).toBe("local");
    expect(result.data).toEqual({ result: "test" });
  });

  it("returns ResponseEnvelope with local source", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation("op1"));

    const env = buildEnv({
      registry,
      context: {} as OperationContext,
    });

    const result = await env.test.op1({ value: "hello" });
    expect(isResponseEnvelope(result)).toBe(true);
    expect(result.meta.source).toBe("local");
    if (result.meta.source === "local") {
      expect(result.meta.operationId).toBe("test.op1");
      expect(typeof result.meta.timestamp).toBe("number");
    }
    expect(result.data).toEqual({ result: "hello" });
  });

  it("passes pre-built ResponseEnvelope through from handler", async () => {
    const registry = new OperationRegistry();
    const httpEnv = httpEnvelope({ items: [1, 2, 3] }, {
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
      inputSchema: Type.Object({ value: Type.String() }),
      outputSchema: Type.Unknown(),
      accessControl: { requiredScopes: [] },
      handler: async () => httpEnv,
    });

    const env = buildEnv({
      registry,
      context: {} as OperationContext,
    });

    const result = await env.test.httpOp({ value: "x" });
    expect(isResponseEnvelope(result)).toBe(true);
    expect(result.meta.source).toBe("http");
    expect(result.data).toEqual({ items: [1, 2, 3] });
  });

  it("filters out SUBSCRIPTION operations", () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation("query"));
    async function* subHandler(input: any) { yield { result: input.value }; }
    registry.register({
      ...makeOperation("onEvent", subHandler),
      type: OperationType.SUBSCRIPTION,
    });

    const env = buildEnv({
      registry,
      context: {} as OperationContext,
    });

    expect(env.test.query).toBeDefined();
    expect(env.test.onEvent).toBeUndefined();
  });

  it("filters by allowedNamespaces", () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation("op1"));
    registry.register({
      ...makeOperation("op2"),
      namespace: "other",
    });

    const env = buildEnv({
      registry,
      context: {} as OperationContext,
      allowedNamespaces: ["test"],
    });

    expect(env.test).toBeDefined();
    expect(env.other).toBeUndefined();
  });

  it("always uses execute() and sets trusted: true on nested context", async () => {
    let capturedContext: OperationContext | undefined;
    const registry = new OperationRegistry();
    registry.register({
      name: "inner",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "inner op",
      inputSchema: Type.Object({ value: Type.String() }),
      outputSchema: Type.Object({ result: Type.String() }),
      accessControl: { requiredScopes: [] },
      handler: async (input: any, ctx: OperationContext) => {
        capturedContext = ctx;
        return { result: input.value };
      },
    });

    const outerContext: OperationContext = {
      requestId: "outer-123",
      identity: { id: "user1", scopes: ["read"] },
    };

    const env = buildEnv({ registry, context: outerContext });
    await env.test.inner({ value: "hello" });

    expect(capturedContext).toBeDefined();
    expect(capturedContext!.trusted).toBe(true);
    expect(capturedContext!.requestId).toBe("outer-123");
    expect(capturedContext!.identity).toEqual({ id: "user1", scopes: ["read"] });
  });

  it("skips access control for trusted nested calls", async () => {
    const registry = new OperationRegistry();
    registry.register({
      name: "guarded",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "guarded op",
      inputSchema: Type.Object({ value: Type.String() }),
      outputSchema: Type.Object({ result: Type.String() }),
      accessControl: {
        requiredScopes: ["admin"],
      },
      handler: async (input: any) => ({ result: input.value }),
    });

    const outerContext: OperationContext = {
      requestId: "outer-456",
      identity: { id: "user1", scopes: ["read"] },
    };

    const env = buildEnv({ registry, context: outerContext });
    const result = await env.test.guarded({ value: "secret" });
    expect(isResponseEnvelope(result)).toBe(true);
    expect(result.data).toEqual({ result: "secret" });
  });

  it("propagates identity through nested calls with trusted flag", async () => {
    let capturedContext: OperationContext | undefined;
    const registry = new OperationRegistry();
    registry.register({
      name: "inner",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "inner op",
      inputSchema: Type.Object({ value: Type.String() }),
      outputSchema: Type.Object({ result: Type.String() }),
      accessControl: { requiredScopes: [] },
      handler: async (input: any, ctx: OperationContext) => {
        capturedContext = ctx;
        return { result: input.value };
      },
    });

    const identity: Identity = { id: "user1", scopes: ["read"] };
    const outerContext: OperationContext = {
      requestId: "parent-req-456",
      identity,
    };

    const env = buildEnv({ registry, context: outerContext });
    await env.test.inner({ value: "test" });

    expect(capturedContext).toBeDefined();
    expect(capturedContext!.identity).toEqual(identity);
    expect(capturedContext!.trusted).toBe(true);
  });

  it("returns empty env when registry has no specs", () => {
    const registry = new OperationRegistry();

    const env = buildEnv({
      registry,
      context: {} as OperationContext,
    });

    expect(Object.keys(env)).toHaveLength(0);
  });

  it("groups operations by namespace", () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation("op1"));
    registry.register({
      ...makeOperation("op2"),
      namespace: "other",
    });

    const env = buildEnv({
      registry,
      context: {} as OperationContext,
    });

    expect(env.test).toBeDefined();
    expect(env.other).toBeDefined();
    expect(env.test.op1).toBeDefined();
    expect(env.other.op2).toBeDefined();
  });

  it("applies Value.Cast normalization via execute", async () => {
    const registry = new OperationRegistry();
    registry.register({
      name: "withDefaults",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "op with default fields",
      inputSchema: Type.Object({ value: Type.String() }),
      outputSchema: Type.Object({ name: Type.String(), count: Type.Number({ default: 0 }) }),
      accessControl: { requiredScopes: [] },
      handler: async () => ({ name: "test" }),
    });

    const env = buildEnv({
      registry,
      context: {} as OperationContext,
    });

    const result = await env.test.withDefaults({ value: "x" });
    expect(isResponseEnvelope(result)).toBe(true);
    expect(result.data).toEqual({ name: "test", count: 0 });
  });
});