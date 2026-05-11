import { describe, it, expect } from "vitest";
import { OperationRegistry, OperationType, buildEnv, type IOperationDefinition, type OperationContext } from "../src/index.js";
import * as Type from "@alkdev/typebox";
import { PendingRequestMap } from "../src/call.js";
import { localEnvelope, isResponseEnvelope, type ResponseEnvelope } from "../src/response-envelope.js";

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
});