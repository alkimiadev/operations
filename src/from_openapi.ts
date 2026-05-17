import * as Type from "@alkdev/typebox";
import { FromSchema } from "./from_schema.js";
import { OperationType, type OperationSpec, type OperationHandler, type SubscriptionHandler, type OperationContext } from "./types.js";
import { CallError, InfrastructureErrorCode } from "./error.js";
import { httpEnvelope } from "./response-envelope.js";
import { OperationRegistry } from "./registry.js";

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
  fetch?: typeof globalThis.fetch;
}

export interface SSEEvent {
  data: string;
  eventType: string;
  lastEventId: string;
}

export function parseSSEFrames(buffer: string): { events: SSEEvent[]; remaining: string } {
  const events: SSEEvent[] = [];
  let remaining = "";

  let text = buffer;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  const lines = text.split(/\r\n|\r|\n/);

  let dataBuffer: string[] = [];
  let eventType = "";
  let lastEventId = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (i === lines.length - 1) {
      remaining = line;
      break;
    }

    if (line === "") {
      if (dataBuffer.length > 0) {
        events.push({
          data: dataBuffer.join("\n"),
          eventType: eventType || "message",
          lastEventId,
        });
      }
      dataBuffer = [];
      eventType = "";
      continue;
    }

    if (line.startsWith(":")) {
      continue;
    }

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      const field = line;
      const value = "";
      processSSEField(field, value, dataBuffer, (type) => { eventType = type; }, (id) => { lastEventId = id; });
      continue;
    }

    const field = line.slice(0, colonIndex);
    let value = line.slice(colonIndex + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    processSSEField(field, value, dataBuffer, (type) => { eventType = type; }, (id) => { lastEventId = id; });
  }

  if (dataBuffer.length > 0) {
    remaining = dataBuffer.join("\n");
  }

  return { events, remaining };
}

function processSSEField(
  field: string,
  value: string,
  dataBuffer: string[],
  setEventType: (type: string) => void,
  setLastEventId: (id: string) => void,
): void {
  switch (field) {
    case "data":
      dataBuffer.push(value);
      break;
    case "event":
      setEventType(value);
      break;
    case "id":
      setLastEventId(value);
      break;
  }
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

type HTTPOperationHandler = OperationHandler<unknown, unknown, OperationContext> | SubscriptionHandler<unknown, unknown, OperationContext>;

function createHTTPOperation(
  spec: OpenAPISpec,
  operation: OpenAPIOperation,
  method: string,
  path: string,
  config: HTTPServiceConfig,
): OperationSpec & { handler: HTTPOperationHandler } {
  const operationId = normalizeOperationId(operation, method, path);
  const opType = detectOperationType(method, operation);
  const apiVersion = spec.info?.version || "1.0.0";
  const authHeaders = getAuthHeaders(config);
  const httpClient = config.fetch ?? globalThis.fetch.bind(globalThis);
  const responseHeaders = (): Record<string, string> => ({ ...authHeaders, "Content-Type": "application/json" });

  if (opType === OperationType.SUBSCRIPTION) {
    const handler: SubscriptionHandler<unknown, unknown, OperationContext> = async function* (input: unknown, context: OperationContext) {
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
        ...(body ? { "Content-Type": "application/json" } : {}),
        "Accept": "text/event-stream",
      };

      const response = await httpClient(url.toString(), {
        method: method.toUpperCase(),
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: config.timeout ? AbortSignal.timeout(config.timeout) : undefined,
      });

      if (!response.ok) {
        throw new CallError(InfrastructureErrorCode.EXECUTION_ERROR, `HTTP ${response.status}: ${response.statusText}`);
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const responseHeadersObj = Object.fromEntries(response.headers.entries());

      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;

          buffer += decoder.decode(chunk, { stream: true });
          const { events, remaining } = parseSSEFrames(buffer);
          buffer = remaining;

          for (const event of events) {
            if (event.data.trim() === "") continue;
            let parsedData: unknown = event.data;
            try {
              parsedData = JSON.parse(event.data);
            } catch {
              // not JSON — yield raw data string
            }
            yield httpEnvelope(parsedData, {
              statusCode: response.status,
              headers: responseHeadersObj,
              contentType: "text/event-stream",
            });
          }
        }
      } finally {
        reader.releaseLock();
      }
    };

    return {
      name: operationId,
      namespace: config.namespace,
      version: apiVersion,
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

    const response = await httpClient(url.toString(), {
      method: method.toUpperCase(),
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: config.timeout ? AbortSignal.timeout(config.timeout) : undefined,
    });

    if (!response.ok) {
      throw new CallError(InfrastructureErrorCode.EXECUTION_ERROR, `HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get("Content-Type") || "";
    let data: unknown;
    if (contentType.includes("application/json")) {
      data = await response.json();
    } else if (contentType.includes("text/")) {
      data = await response.text();
    } else {
      data = await response.arrayBuffer();
    }

    return httpEnvelope(data, {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      contentType,
    });
  };

  return {
    name: operationId,
    namespace: config.namespace,
    version: apiVersion,
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

export function FromOpenAPI(spec: OpenAPISpec, config: HTTPServiceConfig): Array<OperationSpec & { handler: HTTPOperationHandler }> {
  const operations: Array<OperationSpec & { handler: HTTPOperationHandler }> = [];
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

export async function FromOpenAPIFile(path: string, config: HTTPServiceConfig, fs?: OpenAPIFS): Promise<Array<OperationSpec & { handler: HTTPOperationHandler }>> {
  let content: string;
  if (fs) {
    content = await fs.readFile(path);
  } else {
    try {
      const { readFile } = await import("node:fs/promises");
      content = await readFile(path, "utf-8");
    } catch {
      throw new CallError(InfrastructureErrorCode.EXECUTION_ERROR,
        "FromOpenAPIFile: no filesystem provider given and node:fs/promises is not available. " +
        "Provide an OpenAPIFS implementation via the third argument."
      );
    }
  }
  const spec = JSON.parse(content) as OpenAPISpec;
  return FromOpenAPI(spec, config);
}

export async function FromOpenAPIUrl(url: string, config: HTTPServiceConfig): Promise<Array<OperationSpec & { handler: HTTPOperationHandler }>> {
  const httpClient = config.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await httpClient(url);
  const spec = await response.json() as OpenAPISpec;
  return FromOpenAPI(spec, config);
}

export class OpenAPIServiceRegistry {
  private services: Map<string, { config: HTTPServiceConfig; operations: Array<OperationSpec & { handler: HTTPOperationHandler }> }> = new Map();

  add(name: string, spec: OpenAPISpec, config: HTTPServiceConfig): Array<OperationSpec & { handler: HTTPOperationHandler }> {
    const operations = FromOpenAPI(spec, config);
    this.services.set(name, { config, operations });
    return operations;
  }

  async addFromFile(name: string, path: string, config: HTTPServiceConfig, fs?: OpenAPIFS): Promise<Array<OperationSpec & { handler: HTTPOperationHandler }>> {
    const operations = await FromOpenAPIFile(path, config, fs);
    this.services.set(name, { config, operations });
    return operations;
  }

  async addFromUrl(name: string, url: string, config: HTTPServiceConfig): Promise<Array<OperationSpec & { handler: HTTPOperationHandler }>> {
    const operations = await FromOpenAPIUrl(url, config);
    this.services.set(name, { config, operations });
    return operations;
  }

  get(name: string): Array<OperationSpec & { handler: HTTPOperationHandler }> | undefined {
    return this.services.get(name)?.operations;
  }

  getAll(): Array<OperationSpec & { handler: HTTPOperationHandler }> {
    const all: Array<OperationSpec & { handler: HTTPOperationHandler }> = [];
    for (const { operations } of this.services.values()) {
      all.push(...operations);
    }
    return all;
  }

  remove(name: string): boolean {
    return this.services.delete(name);
  }

  registerAll(registry: OperationRegistry): void {
    for (const { operations } of this.services.values()) {
      registry.registerAll(operations);
    }
  }

  get size(): number {
    return this.services.size;
  }
}