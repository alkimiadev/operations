import * as Type from "@alkdev/typebox";
import { FromSchema } from "./from_schema.js";
import { OperationType, type IOperationDefinition, type OperationHandler, type OperationContext } from "./types.js";

export interface OpenAPIFS {
  readFile(path: string): Promise<string>;
}

export interface OpenAPISpec {
  openapi?: string;
  swagger?: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, OpenAPIOperation>>;
  components?: { schemas?: Record<string, unknown> };
  definitions?: Record<string, unknown>;
  basePath?: string;
}

export interface OpenAPIOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenAPIParameter[];
  requestBody?: {
    content?: Record<string, { schema?: unknown }>;
  };
  responses?: Record<string, { content?: Record<string, { schema?: unknown }>; description?: string }>;
}

export interface OpenAPIParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  schema?: unknown;
  description?: string;
}

export interface HTTPServiceConfig {
  namespace: string;
  baseUrl: string;
  headers?: Record<string, string>;
  auth?: {
    type: "bearer" | "apiKey" | "basic";
    token?: string;
    headerName?: string;
    prefix?: string;
  };
  timeout?: number;
}

function resolveRef(spec: OpenAPISpec, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    throw new Error(`External refs not supported: ${ref}`);
  }

  const parts = ref.slice(2).split("/");
  let current: unknown = spec;

  for (const part of parts) {
    if (typeof current !== "object" || current === null) {
      throw new Error(`Cannot resolve ref: ${ref}`);
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function resolveRefsRecursive(
  spec: OpenAPISpec,
  schema: unknown,
  visited: Set<unknown> = new Set(),
): unknown {
  if (typeof schema !== "object" || schema === null) {
    return schema;
  }

  if (visited.has(schema)) {
    return { type: "object", description: "[circular reference]" };
  }

  visited.add(schema);

  if (Array.isArray(schema)) {
    return schema.map((item) => resolveRefsRecursive(spec, item, visited));
  }

  const obj = schema as Record<string, unknown>;

  if (obj.$ref && typeof obj.$ref === "string") {
    const resolved = resolveRef(spec, obj.$ref);
    return resolveRefsRecursive(spec, resolved, visited);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = resolveRefsRecursive(spec, value, visited);
  }

  return result;
}

function buildInputSchema(
  spec: OpenAPISpec,
  operation: OpenAPIOperation,
): Type.TSchema {
  const properties: Record<string, Type.TSchema> = {};
  const required: string[] = [];

  if (operation.parameters) {
    for (const param of operation.parameters) {
      const paramSchema = param.schema
        ? FromSchema(resolveRefsRecursive(spec, param.schema) as Record<string, unknown>)
        : Type.String();

      properties[param.name] = paramSchema;

      if (param.required) {
        required.push(param.name);
      }
    }
  }

  if (operation.requestBody?.content?.["application/json"]?.schema) {
    const bodySchema = resolveRefsRecursive(
      spec,
      operation.requestBody.content["application/json"].schema,
    ) as Record<string, unknown>;
    properties.body = FromSchema(bodySchema);
    required.push("body");
  }

  if (Object.keys(properties).length === 0) {
    return Type.Object({});
  }

  const propsWithOptional: Record<string, Type.TSchema> = {};
  for (const [key, schema] of Object.entries(properties)) {
    if (required.includes(key)) {
      propsWithOptional[key] = schema;
    } else {
      propsWithOptional[key] = Type.Optional(schema);
    }
  }

  return Type.Object(propsWithOptional);
}

function buildOutputSchema(
  spec: OpenAPISpec,
  operation: OpenAPIOperation,
): Type.TSchema {
  const successResponse = operation.responses?.["200"] || operation.responses?.["201"];

  if (!successResponse?.content) {
    return Type.Unknown();
  }

  const jsonSchema = successResponse.content["application/json"]?.schema;
  if (!jsonSchema) {
    const eventStreamSchema = successResponse.content["text/event-stream"]?.schema;
    if (eventStreamSchema) {
      return FromSchema(resolveRefsRecursive(spec, eventStreamSchema) as Record<string, unknown>);
    }
    return Type.Unknown();
  }

  return FromSchema(resolveRefsRecursive(spec, jsonSchema) as Record<string, unknown>);
}

function detectOperationType(method: string, operation: OpenAPIOperation): OperationType {
  const successResponse = operation.responses?.["200"] || operation.responses?.["201"];
  
  if (successResponse?.content && "text/event-stream" in successResponse.content) {
    return OperationType.SUBSCRIPTION;
  }
  
  if (method.toLowerCase() === "get") {
    return OperationType.QUERY;
  }
  
  return OperationType.MUTATION;
}

function normalizeOperationId(op: OpenAPIOperation, method: string, path: string): string {
  if (op.operationId) {
    return op.operationId;
  }

  const pathParts = path.split("/").filter((p) => p && !p.startsWith("{"));
  const baseName = pathParts.join("_") || "root";
  return `${method}_${baseName}`;
}

function getAuthHeaders(config: HTTPServiceConfig): Record<string, string> {
  const headers: Record<string, string> = { ...config.headers };

  if (config.auth) {
    const token = config.auth.token;
    
    if (token) {
      switch (config.auth.type) {
        case "bearer":
          headers["Authorization"] = `Bearer ${token}`;
          break;
        case "apiKey":
          const headerName = config.auth.headerName || "X-API-Key";
          const prefix = config.auth.prefix || "";
          headers[headerName] = prefix + token;
          break;
        case "basic":
          headers["Authorization"] = `Basic ${token}`;
          break;
      }
    }
  }

  return headers;
}

function createHTTPOperation(
  spec: OpenAPISpec,
  operation: OpenAPIOperation,
  method: string,
  path: string,
  config: HTTPServiceConfig,
): IOperationDefinition {
  const operationId = normalizeOperationId(operation, method, path);
  const opType = detectOperationType(method, operation);
  const authHeaders = getAuthHeaders(config);

  const handler: OperationHandler<unknown, unknown, OperationContext> = async (input: unknown, context: OperationContext) => {
    const inputObj = (input as Record<string, unknown>) || {};
    
    let urlPath = path;
    const queryParams: Record<string, string> = {};
    let body: unknown = undefined;

    for (const [key, value] of Object.entries(inputObj)) {
      if (path.includes(`{${key}}`)) {
        urlPath = urlPath.replace(`{${key}}`, encodeURIComponent(String(value)));
      } else if (key === "body") {
        body = value;
      } else {
        queryParams[key] = String(value);
      }
    }

    const url = new URL(config.baseUrl + urlPath);
    for (const [key, value] of Object.entries(queryParams)) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      ...authHeaders,
      "Content-Type": "application/json",
    };

    const response = await fetch(url.toString(), {
      method: method.toUpperCase(),
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: config.timeout ? AbortSignal.timeout(config.timeout) : undefined,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get("Content-Type") || "";
    
    if (contentType.includes("application/json")) {
      return response.json();
    } else if (contentType.includes("text/")) {
      return response.text();
    } else {
      return response.arrayBuffer();
    }
  };

  return {
    name: operationId,
    namespace: config.namespace,
    version: "1.0.0",
    type: opType,
    description: operation.description || operation.summary || `${method.toUpperCase()} ${path}`,
    tags: operation.tags,
    inputSchema: buildInputSchema(spec, operation),
    outputSchema: buildOutputSchema(spec, operation),
    accessControl: { requiredScopes: [] },
    handler,
    _meta: {
      method: method.toUpperCase(),
      path,
      summary: operation.summary,
    },
  };
}

export function FromOpenAPI(spec: OpenAPISpec, config: HTTPServiceConfig): IOperationDefinition[] {
  const operations: IOperationDefinition[] = [];
  const basePath = spec.basePath || "";

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) {
        continue;
      }

      if (!operation || typeof operation !== "object") {
        continue;
      }

      const op = operation as OpenAPIOperation;
      operations.push(createHTTPOperation(spec, op, method, basePath + path, config));
    }
  }

  return operations;
}

export async function FromOpenAPIFile(path: string, config: HTTPServiceConfig, fs?: OpenAPIFS): Promise<IOperationDefinition[]> {
  let content: string;
  if (fs) {
    content = await fs.readFile(path);
  } else {
    const { readFile } = await import("node:fs/promises");
    content = await readFile(path, "utf-8");
  }
  const spec = JSON.parse(content) as OpenAPISpec;
  return FromOpenAPI(spec, config);
}

export async function FromOpenAPIUrl(url: string, config: HTTPServiceConfig): Promise<IOperationDefinition[]> {
  const response = await fetch(url);
  const spec = await response.json() as OpenAPISpec;
  return FromOpenAPI(spec, config);
}