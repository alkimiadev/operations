import { describe, it, expect, vi } from "vitest";
import { OperationRegistry, OperationType, buildEnv, type IOperationDefinition, type OperationContext } from "../src/index.js";
import * as Type from "@alkdev/typebox";
import { PendingRequestMap } from "../src/call.js";
import { localEnvelope, httpEnvelope, isResponseEnvelope, type ResponseEnvelope } from "../src/response-envelope.js";
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
  it("creates namespace-keyed env in direct mode", async () => {
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

  it("returns ResponseEnvelope with local source from direct mode", async () => {
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

  it("passes pre-built ResponseEnvelope through from handler in direct mode", async () => {
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
    registry.register({
      ...makeOperation("onEvent"),
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

  it("routes through callMap in call protocol mode", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation("readFile"));

    const callMap = {
      call: async (opId: string, input: unknown, opts?: any): Promise<ResponseEnvelope> => {
        return localEnvelope({ result: `routed: ${opId}` }, opId);
      },
    };

    const env = buildEnv({
      registry,
      context: {} as OperationContext,
      callMap,
    });

    const result = await env.test.readFile({ value: "test" });
    expect(isResponseEnvelope(result)).toBe(true);
    expect(result.data).toEqual({ result: "routed: test.readFile" });
  });

  it("passes parentRequestId through callMap in call protocol mode", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation("op1"));

    let capturedOptions: any = null;
    const callMap = {
      call: async (opId: string, input: unknown, opts?: any): Promise<ResponseEnvelope> => {
        capturedOptions = opts;
        return localEnvelope({ result: "ok" }, opId);
      },
    };

    const context: OperationContext = {
      requestId: "parent-req-123",
    };

    const env = buildEnv({
      registry,
      context,
      callMap,
    });

    await env.test.op1({ value: "test" });

    expect(capturedOptions).not.toBeNull();
    expect(capturedOptions.parentRequestId).toBe("parent-req-123");
  });

  it("passes identity through callMap in call protocol mode", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation("op1"));

    let capturedOptions: any = null;
    const callMap = {
      call: async (opId: string, input: unknown, opts?: any): Promise<ResponseEnvelope> => {
        capturedOptions = opts;
        return localEnvelope({ result: "ok" }, opId);
      },
    };

    const identity: Identity = { id: "user1", scopes: ["read"] };
    const context: OperationContext = {
      requestId: "parent-req-456",
      identity,
    };

    const env = buildEnv({
      registry,
      context,
      callMap,
    });

    await env.test.op1({ value: "test" });

    expect(capturedOptions).not.toBeNull();
    expect(capturedOptions.parentRequestId).toBe("parent-req-456");
    expect(capturedOptions.identity).toEqual(identity);
  });

  it("does not pass identity when context has no identity in call protocol mode", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation("op1"));

    let capturedOptions: any = null;
    const callMap = {
      call: async (opId: string, input: unknown, opts?: any): Promise<ResponseEnvelope> => {
        capturedOptions = opts;
        return localEnvelope({ result: "ok" }, opId);
      },
    };

    const context: OperationContext = {
      requestId: "parent-req-789",
    };

    const env = buildEnv({
      registry,
      context,
      callMap,
    });

    await env.test.op1({ value: "test" });

    expect(capturedOptions).not.toBeNull();
    expect(capturedOptions.parentRequestId).toBe("parent-req-789");
    expect(capturedOptions.identity).toBeUndefined();
  });

  it("works with PendingRequestMap as callMap", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation("echo"));

    const callMap = new PendingRequestMap();
    const env = buildEnv({
      registry,
      context: {} as OperationContext,
      callMap,
    });

    const callPromise = env.test.echo({ value: "hello" });

    const requestId = [...(callMap as any).requests.keys()][0];
    callMap.respond(requestId, localEnvelope({ result: "echoed" }, "test.echo"));

    const result = await callPromise;
    expect(isResponseEnvelope(result)).toBe(true);
    expect(result.data).toEqual({ result: "echoed" });
    expect(result.meta.source).toBe("local");
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

  it("Value.Cast normalization applies in direct mode via execute", async () => {
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