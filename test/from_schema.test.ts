import { describe, it, expect } from "vitest";
import { FromSchema } from "../src/from_schema.js";
import * as Type from "@alkdev/typebox";
import { KindGuard } from "@alkdev/typebox";
import { Value } from "@alkdev/typebox/value";

describe("FromSchema", () => {
  it("converts a simple object schema", () => {
    const jsonSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    };
    const tbox = FromSchema(jsonSchema);
    expect(KindGuard.IsSchema(tbox)).toBe(true);
    expect(Value.Check(tbox, { name: "Alice" })).toBe(true);
    expect(Value.Check(tbox, { name: "Alice", age: 30 })).toBe(true);
  });

  it("converts string schema", () => {
    const tbox = FromSchema({ type: "string" });
    expect(KindGuard.IsSchema(tbox)).toBe(true);
    expect(Value.Check(tbox, "hello")).toBe(true);
  });

  it("converts number schema", () => {
    const tbox = FromSchema({ type: "number" });
    expect(Value.Check(tbox, 42)).toBe(true);
  });

  it("converts integer schema", () => {
    const tbox = FromSchema({ type: "integer" });
    expect(Value.Check(tbox, 1)).toBe(true);
  });

  it("converts boolean schema", () => {
    const tbox = FromSchema({ type: "boolean" });
    expect(Value.Check(tbox, true)).toBe(true);
  });

  it("converts null schema", () => {
    const tbox = FromSchema({ type: "null" });
    expect(Value.Check(tbox, null)).toBe(true);
  });

  it("converts enum schema", () => {
    const tbox = FromSchema({ enum: ["a", "b", "c"] });
    expect(Value.Check(tbox, "a")).toBe(true);
    expect(Value.Check(tbox, "d")).toBe(false);
  });

  it("converts array schema", () => {
    const tbox = FromSchema({ type: "array", items: { type: "string" } });
    expect(Value.Check(tbox, ["a", "b"])).toBe(true);
  });

  it("converts tuple schema", () => {
    const tbox = FromSchema({ type: "array", items: [{ type: "string" }, { type: "number" }] });
    expect(Value.Check(tbox, ["a", 1])).toBe(true);
  });

  it("converts allOf schema", () => {
    const tbox = FromSchema({
      allOf: [
        { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        { type: "object", properties: { age: { type: "number" } }, required: ["age"] },
      ],
    });
    expect(Value.Check(tbox, { name: "A", age: 1 })).toBe(true);
  });

  it("converts anyOf schema", () => {
    const tbox = FromSchema({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
    expect(Value.Check(tbox, "hello")).toBe(true);
    expect(Value.Check(tbox, 42)).toBe(true);
  });

  it("converts oneOf schema", () => {
    const tbox = FromSchema({
      oneOf: [{ type: "string" }, { type: "number" }],
    });
    expect(Value.Check(tbox, "hello")).toBe(true);
    expect(Value.Check(tbox, 42)).toBe(true);
  });

  it("converts const schema with object value", () => {
    const tbox = FromSchema({ const: { key: "value" } });
    expect(KindGuard.IsSchema(tbox)).toBe(true);
  });

  it("converts primitive const as literal (falls through to Unknown for non-object const)", () => {
    const tbox = FromSchema({ const: "fixed" });
    expect(KindGuard.IsSchema(tbox)).toBe(true);
  });

  it("converts $ref schema", () => {
    const tbox = FromSchema({ $ref: "#/definitions/MyType" });
    expect(KindGuard.IsSchema(tbox)).toBe(true);
  });

  it("returns Unknown for unrecognized schemas", () => {
    const tbox = FromSchema({});
    expect(KindGuard.IsSchema(tbox)).toBe(true);
  });
});