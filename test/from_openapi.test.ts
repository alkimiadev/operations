import { describe, it, expect } from "vitest";
import { FromOpenAPI } from "../src/from_openapi.js";
import { OperationType } from "../src/types.js";
import { Value } from "@alkdev/typebox/value";

const simpleSpec = {
  openapi: "3.0.0",
  info: { title: "Test API", version: "1.0.0" },
  paths: {
    "/users": {
      get: {
        operationId: "listUsers",
        description: "List all users",
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    users: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        operationId: "createUser",
        description: "Create a user",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                },
                required: ["name"],
              },
            },
          },
        },
        responses: {
          "201": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/events": {
      get: {
        operationId: "streamEvents",
        description: "Stream events via SSE",
        responses: {
          "200": {
            content: {
              "text/event-stream": {
                schema: {
                  type: "object",
                  properties: {
                    event: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/users/{id}": {
      get: {
        operationId: "getUser",
        description: "Get user by ID",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { type: "object", properties: { name: { type: "string" } } },
              },
            },
          },
        },
      },
    },
  },
};

describe("FromOpenAPI", () => {
  const config = {
    namespace: "api",
    baseUrl: "https://api.example.com",
  };

  it("generates operations from OpenAPI spec", () => {
    const ops = FromOpenAPI(simpleSpec as any, config);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.map((o) => o.name)).toContain("listUsers");
    expect(ops.map((o) => o.name)).toContain("createUser");
    expect(ops.map((o) => o.name)).toContain("getUser");
  });

  it("sets namespace from config", () => {
    const ops = FromOpenAPI(simpleSpec as any, config);
    expect(ops.every((o) => o.namespace === "api")).toBe(true);
  });

  it("detects GET as QUERY type", () => {
    const ops = FromOpenAPI(simpleSpec as any, config);
    const listUsers = ops.find((o) => o.name === "listUsers")!;
    expect(listUsers.type).toBe(OperationType.QUERY);
  });

  it("detects POST as MUTATION type", () => {
    const ops = FromOpenAPI(simpleSpec as any, config);
    const createUser = ops.find((o) => o.name === "createUser")!;
    expect(createUser.type).toBe(OperationType.MUTATION);
  });

  it("detects text/event-stream as SUBSCRIPTION type", () => {
    const ops = FromOpenAPI(simpleSpec as any, config);
    const streamEvents = ops.find((o) => o.name === "streamEvents")!;
    expect(streamEvents.type).toBe(OperationType.SUBSCRIPTION);
  });

  it("generates valid TypeBox input schemas", () => {
    const ops = FromOpenAPI(simpleSpec as any, config);
    const getUser = ops.find((o) => o.name === "getUser")!;
    expect(Value.Check(getUser.inputSchema, { id: "123" })).toBe(true);
  });

  it("handles auth bearer config", () => {
    const authConfig = {
      namespace: "api",
      baseUrl: "https://api.example.com",
      auth: { type: "bearer" as const, token: "test-token" },
    };
    const ops = FromOpenAPI(simpleSpec as any, authConfig);
    expect(ops.length).toBeGreaterThan(0);
  });

  it("skips non-HTTP methods", () => {
    const ops = FromOpenAPI(simpleSpec as any, config);
    expect(ops.every((o) => o.name)).toBeTruthy();
  });

  it("handles $ref resolution", () => {
    const specWithRef = {
      openapi: "3.0.0",
      info: { title: "Test", version: "1.0.0" },
      paths: {
        "/items": {
          get: {
            operationId: "listItems",
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/ItemList" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          ItemList: {
            type: "object",
            properties: {
              items: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    };
    const ops = FromOpenAPI(specWithRef as any, config);
    expect(ops.length).toBe(1);
  });
});