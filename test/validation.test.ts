import { describe, it, expect } from "vitest";
import { formatValueErrors, assertIsSchema, validateOrThrow, collectErrors } from "../src/validation.js";
import { Type } from "@alkdev/typebox";
import { KindGuard } from "@alkdev/typebox";
import { Value } from "@alkdev/typebox/value";

describe("formatValueErrors", () => {
  it("formats errors with default indent", () => {
    const errors = [{ path: "/foo", message: "Expected string" }];
    expect(formatValueErrors(errors)).toBe("  - /foo: Expected string");
  });

  it("formats errors with custom indent", () => {
    const errors = [{ path: "/bar", message: "Expected number" }];
    expect(formatValueErrors(errors, "  * ")).toBe("  * /bar: Expected number");
  });

  it("formats multiple errors", () => {
    const errors = [
      { path: "/a", message: "Error 1" },
      { path: "/b", message: "Error 2" },
    ];
    expect(formatValueErrors(errors)).toBe("  - /a: Error 1\n  - /b: Error 2");
  });
});

describe("assertIsSchema", () => {
  it("passes for valid TypeBox schemas", () => {
    expect(() => assertIsSchema(Type.String())).not.toThrow();
  });

  it("passes for Type.Unknown()", () => {
    expect(() => assertIsSchema(Type.Unknown())).not.toThrow();
  });

  it("throws for plain JSON schema objects", () => {
    expect(() => assertIsSchema({ type: "string" })).toThrow("Not a valid TypeBox schema");
  });

  it("includes context in error message", () => {
    expect(() => assertIsSchema({ type: "string" }, "myOp inputSchema")).toThrow(
      "for myOp inputSchema"
    );
  });
});

describe("validateOrThrow", () => {
  it("passes for valid input", () => {
    const schema = Type.Object({ name: Type.String() });
    expect(() => validateOrThrow(schema, { name: "test" })).not.toThrow();
  });

  it("throws for invalid input", () => {
    const schema = Type.Object({ name: Type.String() });
    expect(() => validateOrThrow(schema, { name: 123 })).toThrow("Validation failed");
  });

  it("includes context in error message", () => {
    const schema = Type.Object({ name: Type.String() });
    expect(() => validateOrThrow(schema, { name: 123 }, "myOp")).toThrow("for myOp");
  });
});

describe("collectErrors", () => {
  it("returns empty array for valid input", () => {
    const schema = Type.Object({ name: Type.String() });
    expect(collectErrors(schema, { name: "test" })).toEqual([]);
  });

  it("returns errors for invalid input", () => {
    const schema = Type.Object({ name: Type.String() });
    const errors = collectErrors(schema, { name: 123 });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].path).toBeDefined();
    expect(errors[0].message).toBeDefined();
  });
});