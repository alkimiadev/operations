import { describe, it, expect } from "vitest";
import { CallError, InfrastructureErrorCode, mapError } from "../src/error.js";

describe("CallError", () => {
  it("stores code, message, and details", () => {
    const err = new CallError("TEST_CODE", "test message", { foo: "bar" });
    expect(err.code).toBe("TEST_CODE");
    expect(err.message).toBe("test message");
    expect(err.details).toEqual({ foo: "bar" });
    expect(err.name).toBe("CallError");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CallError);
  });

  it("works without details", () => {
    const err = new CallError("CODE", "msg");
    expect(err.details).toBeUndefined();
  });
});

describe("InfrastructureErrorCode", () => {
  it("has all expected codes", () => {
    expect(InfrastructureErrorCode.OPERATION_NOT_FOUND).toBe("OPERATION_NOT_FOUND");
    expect(InfrastructureErrorCode.ACCESS_DENIED).toBe("ACCESS_DENIED");
    expect(InfrastructureErrorCode.VALIDATION_ERROR).toBe("VALIDATION_ERROR");
    expect(InfrastructureErrorCode.TIMEOUT).toBe("TIMEOUT");
    expect(InfrastructureErrorCode.ABORTED).toBe("ABORTED");
    expect(InfrastructureErrorCode.EXECUTION_ERROR).toBe("EXECUTION_ERROR");
    expect(InfrastructureErrorCode.UNKNOWN_ERROR).toBe("UNKNOWN_ERROR");
  });
});

describe("mapError", () => {
  it("passes through existing CallError", () => {
    const original = new CallError("CUSTOM", "msg");
    const result = mapError(original);
    expect(result).toBe(original);
  });

  it("maps Error to EXECUTION_ERROR", () => {
    const result = mapError(new Error("something broke"));
    expect(result.code).toBe(InfrastructureErrorCode.EXECUTION_ERROR);
    expect(result.message).toBe("something broke");
  });

  it("maps Error with matching errorSchema code", () => {
    const result = mapError(new Error("NOT_FOUND: item missing"), [
      { code: "NOT_FOUND", schema: {} },
    ]);
    expect(result.code).toBe("NOT_FOUND");
  });

  it("does not false-positive on substring match (ITEM_NOT_FOUND vs NOT_FOUND)", () => {
    const result = mapError(new Error("ITEM_NOT_FOUND: nope"), [
      { code: "NOT_FOUND", schema: {} },
    ]);
    expect(result.code).toBe(InfrastructureErrorCode.EXECUTION_ERROR);
  });

  it("matches exact code equality", () => {
    const result = mapError(new Error("NOT_FOUND"), [
      { code: "NOT_FOUND", schema: {} },
    ]);
    expect(result.code).toBe("NOT_FOUND");
  });

  it("maps non-Error to UNKNOWN_ERROR", () => {
    const result = mapError("string error");
    expect(result.code).toBe(InfrastructureErrorCode.UNKNOWN_ERROR);
    expect(result.message).toBe("string error");
    expect(result.details).toEqual({ raw: "string error" });
  });

  it("maps non-Error with details", () => {
    const result = mapError(42);
    expect(result.code).toBe(InfrastructureErrorCode.UNKNOWN_ERROR);
    expect(result.details).toEqual({ raw: "42" });
  });
});