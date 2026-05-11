import { describe, it, expect } from "vitest";
import { OperationRegistry } from "../src/registry.js";
import { OperationType, type IOperationDefinition, type OperationContext, type OperationSpec, type OperationHandler } from "../src/index.js";
import { isResponseEnvelope, localEnvelope, type ResponseEnvelope } from "../src/response-envelope.js";
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

  it("throws on missing operation", async () => {
    const registry = new OperationRegistry();
    await expect(
      registry.execute("missing.op", {}, {} as OperationContext)
    ).rejects.toThrow("Operation not found");
  });

  it("throws on missing handler", async () => {
    const registry = new OperationRegistry();
    registry.registerSpec(makeSpec());
    await expect(
      registry.execute("test.testOp", { value: "hello" }, {} as OperationContext)
    ).rejects.toThrow("No handler registered");
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