import { describe, it, expect } from "vitest";
import { PendingRequestMap } from "../src/call.js";
import { CallError, InfrastructureErrorCode } from "../src/error.js";

describe("PendingRequestMap", () => {
  it("creates instance without event target", () => {
    const map = new PendingRequestMap();
    expect(map.getPendingCount()).toBe(0);
  });

  it("creates instance with event target", () => {
    const target = new EventTarget();
    const map = new PendingRequestMap(target);
    expect(map.getPendingCount()).toBe(0);
  });

  it("call() resolves when respond() is called", async () => {
    const map = new PendingRequestMap();

    const callPromise = map.call("test.op", { value: "hello" });

    setTimeout(() => {
      const requestId = [...map["requests"].keys()][0];
      map.respond(requestId, { result: "world" });
    }, 10);

    const result = await callPromise;
    expect(result).toEqual({ result: "world" });
  });

  it("call() rejects when emitError() is called", async () => {
    const map = new PendingRequestMap();

    const callPromise = map.call("test.op", { value: "hello" });

    setTimeout(() => {
      const requestId = [...map["requests"].keys()][0];
      map.emitError(requestId, "CUSTOM_ERROR", "Something went wrong");
    }, 10);

    await expect(callPromise).rejects.toThrow("Something went wrong");
    await expect(callPromise).rejects.toBeInstanceOf(CallError);
  });

  it("abort() rejects the pending call", async () => {
    const map = new PendingRequestMap();

    const callPromise = map.call("test.op", { value: "hello" });

    setTimeout(() => {
      const requestId = [...map["requests"].keys()][0];
      map.abort(requestId);
    }, 10);

    await expect(callPromise).rejects.toThrow("was aborted");
    await expect(callPromise).rejects.toBeInstanceOf(CallError);
  });

  it("call() with deadline times out", async () => {
    const map = new PendingRequestMap();

    const deadline = Date.now() + 50;
    const callPromise = map.call("test.op", { value: "hello" }, { deadline });

    await expect(callPromise).rejects.toThrow("timed out");
    await expect(callPromise).rejects.toBeInstanceOf(CallError);
  });

  it("tracks pending requests", () => {
    const map = new PendingRequestMap();
    map.call("test.op1", {});
    map.call("test.op2", {});
    expect(map.getPendingCount()).toBe(2);
  });

  it("cleans up after call resolves", async () => {
    const map = new PendingRequestMap();
    const callPromise = map.call("test.op", { value: "hello" });
    expect(map.getPendingCount()).toBe(1);

    const requestId = [...map["requests"].keys()][0];
    map.respond(requestId, { result: "done" });

    await callPromise;
    expect(map.getPendingCount()).toBe(0);
  });
});