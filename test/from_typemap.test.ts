import { describe, it, expect } from "vitest";
import { defaultAdapter, zodAdapter, valibotAdapter, type SchemaAdapter } from "../src/from_typemap.js";
import * as Type from "@alkdev/typebox";
import { KindGuard } from "@alkdev/typebox";
import { OperationRegistry, type RegistryOptions } from "../src/registry.js";
import { OperationType, type IOperationDefinition } from "../src/index.js";

describe("defaultAdapter", () => {
  it("passes through TypeBox schemas unchanged", () => {
    const schema = Type.Object({ name: Type.String() });
    const result = defaultAdapter.toTypeBox(schema);
    expect(result).toBe(schema);
  });

  it("throws for non-TypeBox schemas", () => {
    expect(() => defaultAdapter.toTypeBox({})).toThrow("expected a TypeBox schema");
    expect(() => defaultAdapter.toTypeBox("string")).toThrow("expected a TypeBox schema");
    expect(() => defaultAdapter.toTypeBox(42)).toThrow("expected a TypeBox schema");
  });
});

describe("zodAdapter", () => {
  it("passes through TypeBox schemas without init", () => {
    const adapter = zodAdapter();
    const schema = Type.Object({ name: Type.String() });
    const result = adapter.toTypeBox(schema);
    expect(result).toBe(schema);
  });

  it("throws for non-TypeBox schemas when not initialized", () => {
    const adapter = zodAdapter();
    expect(() => adapter.toTypeBox({})).toThrow("not initialized");
  });

  it("converts Zod schemas after init", async () => {
    const adapter = zodAdapter();
    await adapter.init();
    const { z } = await import("zod");
    const zodSchema = z.object({ name: z.string(), age: z.number() });
    const result = adapter.toTypeBox(zodSchema);
    expect(KindGuard.IsSchema(result)).toBe(true);
  });

  it("passes through TypeBox schemas after init", async () => {
    const adapter = zodAdapter();
    await adapter.init();
    const schema = Type.Object({ name: Type.String() });
    const result = adapter.toTypeBox(schema);
    expect(result).toBe(schema);
  });

  it("throws for unrecognized schemas after init", async () => {
    const adapter = zodAdapter();
    await adapter.init();
    expect(() => adapter.toTypeBox(42)).toThrow("not a Zod or TypeBox schema");
  });

  it("init is idempotent", async () => {
    const adapter = zodAdapter();
    await adapter.init();
    await adapter.init();
  });
});

describe("valibotAdapter", () => {
  it("passes through TypeBox schemas without init", () => {
    const adapter = valibotAdapter();
    const schema = Type.Object({ name: Type.String() });
    const result = adapter.toTypeBox(schema);
    expect(result).toBe(schema);
  });

  it("throws for non-TypeBox schemas when not initialized", () => {
    const adapter = valibotAdapter();
    expect(() => adapter.toTypeBox({})).toThrow("not initialized");
  });

  it("converts Valibot schemas after init", async () => {
    const adapter = valibotAdapter();
    await adapter.init();
    const v = await import("valibot");
    const valibotSchema = v.object({ id: v.string(), active: v.boolean() });
    const result = adapter.toTypeBox(valibotSchema);
    expect(KindGuard.IsSchema(result)).toBe(true);
  });

  it("passes through TypeBox schemas after init", async () => {
    const adapter = valibotAdapter();
    await adapter.init();
    const schema = Type.Object({ name: Type.String() });
    const result = adapter.toTypeBox(schema);
    expect(result).toBe(schema);
  });

  it("throws for unrecognized schemas after init", async () => {
    const adapter = valibotAdapter();
    await adapter.init();
    expect(() => adapter.toTypeBox(42)).toThrow("not a Valibot or TypeBox schema");
  });

  it("init is idempotent", async () => {
    const adapter = valibotAdapter();
    await adapter.init();
    await adapter.init();
  });
});

describe("OperationRegistry with SchemaAdapter", () => {
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

  it("works with default adapter (TypeBox schemas)", async () => {
    const registry = new OperationRegistry();
    registry.register(makeOperation());
    const result = await registry.execute("test.testOp", { value: "hello" }, {});
    expect(result.data).toEqual({ result: "processed: hello" });
  });

  it("works with zodAdapter after init", async () => {
    const adapter = zodAdapter();
    await adapter.init();
    const registry = new OperationRegistry({ schemaAdapter: adapter });
    const { z } = await import("zod");
    registry.register({
      name: "zodOp",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "Operation with Zod schemas",
      inputSchema: z.object({ name: z.string() }) as any,
      outputSchema: z.object({ greeting: z.string() }) as any,
      accessControl: { requiredScopes: [] },
      handler: async (input: any) => ({ greeting: `Hello, ${input.name}` }),
    });
    const result = await registry.execute("test.zodOp", { name: "world" }, {});
    expect(result.data).toEqual({ greeting: "Hello, world" });
  });

  it("works with valibotAdapter after init", async () => {
    const adapter = valibotAdapter();
    await adapter.init();
    const registry = new OperationRegistry({ schemaAdapter: adapter });
    const v = await import("valibot");
    registry.register({
      name: "valOp",
      namespace: "test",
      version: "1.0.0",
      type: OperationType.QUERY,
      description: "Operation with Valibot schemas",
      inputSchema: v.object({ id: v.string() }) as any,
      outputSchema: v.object({ status: v.string() }) as any,
      accessControl: { requiredScopes: [] },
      handler: async (input: any) => ({ status: `ok: ${input.id}` }),
    });
    const result = await registry.execute("test.valOp", { id: "abc" }, {});
    expect(result.data).toEqual({ status: "ok: abc" });
  });

  it("throws with defaultAdapter for non-TypeBox schemas", () => {
    const registry = new OperationRegistry();
    expect(() => registry.register({
      ...makeOperation(),
      inputSchema: {} as any,
    })).toThrow("expected a TypeBox schema");
  });

  it("can use TypeBox schemas with zodAdapter (mixed)", async () => {
    const adapter = zodAdapter();
    await adapter.init();
    const registry = new OperationRegistry({ schemaAdapter: adapter });
    registry.register(makeOperation());
    const result = await registry.execute("test.testOp", { value: "hello" }, {});
    expect(result.data).toEqual({ result: "processed: hello" });
  });
});