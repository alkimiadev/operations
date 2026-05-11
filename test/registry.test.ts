import { describe, it, expect } from "vitest";
import { OperationRegistry } from "../src/registry.js";
import { OperationType, type IOperationDefinition, type OperationContext, type OperationSpec, type OperationHandler } from "../src/index.js";
import { isResponseEnvelope, localEnvelope, type ResponseEnvelope } from "../src/response-envelope.js";
import { CallError, InfrastructureErrorCode } from "../src/error.js";
import * as Type from "@alkdev/typebox";
import { Value } from "@alkdev/typebox/value";

function makeOperation(overrides: Partial<IOperationDefinition> = {}): IOperationDefinition {
  return {
    name: "testOp",
    namespace: "test",
    version: "1.0.0",
    type: OperationType.QUERY,
    description: "A test operation",
    inputSchema: Type.Object({ value: Type.String() }),
    outputSchema: Type.Object({ result: Type.String() }),
    accessControl: { requiredScopes: [] },
    handler: async (input: any) => ({ result: `processed: ${input.value}` }),
    ...overrides,
  };
}

function makeSpec(overrides: Partial<OperationSpec> = {}): OperationSpec {
  return {
    name: "testOp",
    namespace: "test",
    version: "1.0.0",
    type: OperationType.QUERY,
    description: "A test operation",
    inputSchema: Type.Object({ value: Type.String() }),
    outputSchema: Type.Object({ result: Type.String() }),
    accessControl: { requiredScopes: [] },
    ...overrides,
  };
}

const testHandler: OperationHandler = async (input: any) => ({ result: `processed: ${input.value}` });

describe("OperationRegistry", () => {
  it("registers and retrieves an operation", () => {
    const registry = new OperationRegistry();
    const op = makeOperation();
    registry.register(op);
    const retrieved = registry.get("test.testOp")!;
    expect(retrieved).toStrictEqual(op);
    expect(retrieved.name).toBe("testOp");
    expect(retrieved.handler).toBeDefined();
  });

  it("retrieves by namespace and name", () => {
    const registry = new OperationRegistry();
    const op = makeOperation();
    registry.register(op);
    const retrieved = registry.getByName("test", "testOp")!;
    expect(retrieved).toStrictEqual(op);
    expect(retrieved.name).toBe("testOp");
  });

  it("returns undefined for missing operations", () => {
    const registry = new OperationRegistry();
    expect(registry.get("nonexistent.op")).toBeUndefined();
  });

  it("lists all registered operations", () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation());
    registry.register(makeOperation({ name: "op2" }));
    expect(registry.list()).toHaveLength(2);
  });

  it("registerAll registers multiple operations", () => {
    const registry = new OperationRegistry();
    registry.registerAll([makeOperation(), makeOperation({ name: "op2" })]);
    expect(registry.list()).toHaveLength(2);
  });

  it("extracts spec without handler", () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation());
    const spec = registry.getSpec("test.testOp")!;
    expect(spec).toBeDefined();
    expect((spec as any).handler).toBeUndefined();
    expect(spec.name).toBe("testOp");
  });

  it("getAllSpecs returns all specs", () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation());
    registry.register(makeOperation({ name: "op2" }));
    expect(registry.getAllSpecs()).toHaveLength(2);
  });

  it("executes an operation and returns ResponseEnvelope", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation());
    const envelope = await registry.execute("test.testOp", { value: "hello" }, {} as OperationContext);
    expect(isResponseEnvelope(envelope)).toBe(true);
    expect(envelope.meta.source).toBe("local");
    expect((envelope.meta as any).operationId).toBe("test.testOp");
    expect(envelope.data).toEqual({ result: "processed: hello" });
  });

  it("wraps raw handler result in localEnvelope", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation());
    const envelope = await registry.execute("test.testOp", { value: "hello" }, {} as OperationContext);
    expect(envelope.meta.source).toBe("local");
    expect(envelope.data).toEqual({ result: "processed: hello" });
    expect(typeof (envelope.meta as any).timestamp).toBe("number");
  });

  it("passes through pre-built ResponseEnvelope from handler", async () => {
    const registry = new OperationRegistry();
    const preBuilt = localEnvelope({ custom: "data" }, "custom.op");
    registry.register(makeOperation({
      handler: async () => preBuilt,
    }));
    const envelope = await registry.execute("test.testOp", { value: "x" }, {} as OperationContext);
    expect(envelope).toBe(preBuilt);
  });

  it("normalizes output with Value.Cast when outputSchema is not Unknown", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation({
      outputSchema: Type.Object({ result: Type.String(), count: Type.Number() }),
      handler: async () => ({ result: "ok" }),
    }));
    const envelope = await registry.execute("test.testOp", { value: "x" }, {} as OperationContext);
    expect((envelope.data as any).result).toBe("ok");
    expect((envelope.data as any).count).toBe(0);
  });

  it("does not normalize when outputSchema is Unknown", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation({
      outputSchema: Type.Unknown(),
      handler: async () => ({ anything: "goes", extra: 42 }),
    }));
    const envelope = await registry.execute("test.testOp", { value: "x" }, {} as OperationContext);
    expect(envelope.data).toEqual({ anything: "goes", extra: 42 });
  });

  it("normalizes mismatched output via Value.Cast and returns envelope", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation({
      handler: async () => ({ unexpected: "field" }),
    }));
    const envelope = await registry.execute("test.testOp", { value: "x" }, {} as OperationContext);
    expect(isResponseEnvelope(envelope)).toBe(true);
    expect((envelope.data as any).result).toBe("");
  });

  it("throws on invalid input", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation());
    await expect(
      registry.execute("test.testOp", { wrong: "field" }, {} as OperationContext)
    ).rejects.toThrow();
  });

  it("throws CallError on missing operation", async () => {
    const registry = new OperationRegistry();
    try {
      await registry.execute("missing.op", {}, {} as OperationContext);
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.OPERATION_NOT_FOUND);
    }
  });

  it("throws CallError on missing handler", async () => {
    const registry = new OperationRegistry();
    registry.registerSpec(makeSpec());
    try {
      await registry.execute("test.testOp", { value: "hello" }, {} as OperationContext);
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.OPERATION_NOT_FOUND);
    }
  });

  it("registerSpec and registerHandler separately", async () => {
    const registry = new OperationRegistry();
    const spec = makeSpec();
    registry.registerSpec(spec);
    registry.registerHandler("test.testOp", testHandler);

    const retrieved = registry.get("test.testOp")!;
    expect(retrieved.name).toBe("testOp");
    expect(retrieved.handler).toBeDefined();

    const envelope = await registry.execute("test.testOp", { value: "hello" }, {} as OperationContext);
    expect(envelope.data).toEqual({ result: "processed: hello" });
    expect(envelope.meta.source).toBe("local");
  });

  it("registerHandler throws for unknown operation", () => {
    const registry = new OperationRegistry();
    expect(() => registry.registerHandler("unknown.op", testHandler)).toThrow("Cannot register handler for unknown operation");
  });

  it("getHandler returns handler", () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation());
    expect(registry.getHandler("test.testOp")).toBeDefined();
  });

  it("getHandler returns undefined for spec-only registration", () => {
    const registry = new OperationRegistry();
    registry.registerSpec(makeSpec());
    expect(registry.getHandler("test.testOp")).toBeUndefined();
  });

  it("register with spec-only (no handler)", () => {
    const registry = new OperationRegistry();
    const spec = makeSpec();
    registry.register(spec);
    const retrieved = registry.get("test.testOp")!;
    expect(retrieved.name).toBe("testOp");
    expect(retrieved.handler).toBeUndefined();
  });

  it("getSpec returns spec without handler after combined register", () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation());
    const spec = registry.getSpec("test.testOp")!;
    expect(spec.name).toBe("testOp");
    expect((spec as any).handler).toBeUndefined();
  });
});

describe("OperationRegistry access control", () => {
  it("denies access when requiredScopes are set and no identity provided", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation({
      accessControl: { requiredScopes: ["admin"] },
    }));

    try {
      await registry.execute("test.testOp", { value: "hello" }, {} as OperationContext);
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.ACCESS_DENIED);
    }
  });

  it("denies access when identity lacks required scopes", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation({
      accessControl: { requiredScopes: ["admin", "write"] },
    }));

    const context: OperationContext = {
      identity: { id: "user1", scopes: ["read"] },
    };

    try {
      await registry.execute("test.testOp", { value: "hello" }, context);
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.ACCESS_DENIED);
    }
  });

  it("grants access when identity has all required scopes", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation({
      accessControl: { requiredScopes: ["read", "write"] },
    }));

    const context: OperationContext = {
      identity: { id: "user1", scopes: ["read", "write", "admin"] },
    };

    const envelope = await registry.execute("test.testOp", { value: "hello" }, context);
    expect(envelope.data).toEqual({ result: "processed: hello" });
  });

  it("grants access when no scopes are required", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation({
      accessControl: { requiredScopes: [] },
    }));

    const envelope = await registry.execute("test.testOp", { value: "hello" }, {} as OperationContext);
    expect(envelope.data).toEqual({ result: "processed: hello" });
  });

  it("denies access when requiredScopesAny requires at least one scope and identity has none", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation({
      accessControl: { requiredScopes: [], requiredScopesAny: ["admin", "write"] },
    }));

    const context: OperationContext = {
      identity: { id: "user1", scopes: ["read"] },
    };

    try {
      await registry.execute("test.testOp", { value: "hello" }, context);
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.ACCESS_DENIED);
    }
  });

  it("grants access when requiredScopesAny and identity has one matching scope", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation({
      accessControl: { requiredScopes: [], requiredScopesAny: ["admin", "write"] },
    }));

    const context: OperationContext = {
      identity: { id: "user1", scopes: ["write"] },
    };

    const envelope = await registry.execute("test.testOp", { value: "hello" }, context);
    expect(envelope.data).toEqual({ result: "processed: hello" });
  });

  it("denies access when resourceType/resourceAction are set and identity has no resources", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation({
      accessControl: { requiredScopes: [], resourceType: "project", resourceAction: "read" },
    }));

    const context: OperationContext = {
      identity: { id: "user1", scopes: [] },
    };

    try {
      await registry.execute("test.testOp", { value: "hello" }, context);
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.ACCESS_DENIED);
    }
  });

  it("grants access when resourceType/resourceAction match identity resources", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation({
      accessControl: { requiredScopes: [], resourceType: "project", resourceAction: "read" },
    }));

    const context: OperationContext = {
      identity: { id: "user1", scopes: [], resources: { "project:abc": ["read", "write"] } },
    };

    const envelope = await registry.execute("test.testOp", { value: "hello" }, context);
    expect(envelope.data).toEqual({ result: "processed: hello" });
  });

  it("skips access control when context.trusted is true", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation({
      accessControl: { requiredScopes: ["admin"] },
    }));

    const context: OperationContext = {
      identity: { id: "user1", scopes: ["read"] },
      trusted: true,
    };

    const envelope = await registry.execute("test.testOp", { value: "hello" }, context);
    expect(envelope.data).toEqual({ result: "processed: hello" });
  });

  it("skips access control when context.trusted is true even without identity", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation({
      accessControl: { requiredScopes: ["admin"] },
    }));

    const context: OperationContext = { trusted: true };

    const envelope = await registry.execute("test.testOp", { value: "hello" }, context);
    expect(envelope.data).toEqual({ result: "processed: hello" });
  });

  it("denies access when identity is missing but requiredScopes are set", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation({
      accessControl: { requiredScopes: ["read"] },
    }));

    const context: OperationContext = {};

    try {
      await registry.execute("test.testOp", { value: "hello" }, context);
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CallError);
      expect((error as CallError).code).toBe(InfrastructureErrorCode.ACCESS_DENIED);
      expect((error as CallError).message).toContain("identity required");
    }
  });
});