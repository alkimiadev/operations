import type { OperationSpec, OperationHandler } from "./types.js";
import { OperationType } from "./types.js";
import { Kind, Type, type TSchema } from "@alkdev/typebox";
import { Value } from "@alkdev/typebox/value";
import { FromSchema } from "./from_schema.js";
import { mcpEnvelope, type MCPContentBlock, type MCPAnnotations, type MCPResourceContent, type MCPResponseMeta } from "./response-envelope.js";
import { CallError, InfrastructureErrorCode } from "./error.js";
import { getLogger } from "@logtape/logtape";

const logger = getLogger("operations:mcp");

export interface MCPClientConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface MCPClientWrapper {
  name: string;
  client: unknown;
  tools: Array<OperationSpec & { handler: OperationHandler }>;
}

export function mapMCPContentBlocks(sdkBlocks: unknown[]): MCPContentBlock[] {
  return sdkBlocks.map((block: unknown): MCPContentBlock => {
    if (typeof block !== "object" || block === null) {
      return { type: "text", text: JSON.stringify(block) };
    }
    const b = block as Record<string, unknown>;
    switch (b.type) {
      case "text":
        return {
          type: "text",
          text: typeof b.text === "string" ? b.text : String(b.text ?? ""),
          ...(b.annotations != null ? { annotations: b.annotations as MCPAnnotations } : {}),
        };
      case "image":
        return {
          type: "image",
          data: typeof b.data === "string" ? b.data : String(b.data ?? ""),
          mimeType: typeof b.mimeType === "string" ? b.mimeType : "application/octet-stream",
          ...(b.annotations != null ? { annotations: b.annotations as MCPAnnotations } : {}),
        };
      case "audio":
        return {
          type: "audio",
          data: typeof b.data === "string" ? b.data : String(b.data ?? ""),
          mimeType: typeof b.mimeType === "string" ? b.mimeType : "audio/octet-stream",
          ...(b.annotations != null ? { annotations: b.annotations as MCPAnnotations } : {}),
        };
      case "resource": {
        const resource = b.resource as Record<string, unknown> | undefined;
        const mappedResource: MCPResourceContent = {
          uri: typeof resource?.uri === "string" ? resource.uri : "",
          ...(resource?.mimeType != null ? { mimeType: String(resource.mimeType) } : {}),
          ...(resource?.text != null ? { text: String(resource.text) } : {}),
          ...(resource?.blob != null ? { blob: String(resource.blob) } : {}),
        };
        return {
          type: "resource",
          resource: mappedResource,
          ...(b.annotations != null ? { annotations: b.annotations as MCPAnnotations } : {}),
        };
      }
      case "resource_link":
        return {
          type: "resource_link",
          uri: typeof b.uri === "string" ? b.uri : String(b.uri ?? ""),
          name: typeof b.name === "string" ? b.name : String(b.name ?? ""),
          ...(b.description != null ? { description: String(b.description) } : {}),
          ...(b.mimeType != null ? { mimeType: String(b.mimeType) } : {}),
        };
      default:
        return { type: "text", text: JSON.stringify(block) };
    }
  });
}

export async function createMCPClient(
  name: string,
  config: MCPClientConfig,
): Promise<MCPClientWrapper> {
  logger.info(`Creating MCP client for: ${name}`);

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const client = new Client({ name: `alkdev-${name}`, version: "1.0.0" });

  let transport: any;

  if (config.url) {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const url = new URL(config.url);
    transport = new StreamableHTTPClientTransport(url, {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });
  } else if (config.command) {
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: config.env as Record<string, string> | undefined,
      cwd: config.cwd,
    });
  } else {
    throw new CallError(InfrastructureErrorCode.EXECUTION_ERROR, `Invalid MCP server config for ${name}: must have either 'url' or 'command'`);
  }

  await client.connect(transport);
  logger.info(`Connected to MCP server: ${name}`);

  const toolsResult = await client.listTools();
  const operations: Array<OperationSpec & { handler: OperationHandler }> = toolsResult.tools.map((tool: { name: string; description?: string; inputSchema: unknown; outputSchema?: unknown }) => {
    const outputSchema: TSchema = tool.outputSchema
      ? FromSchema(tool.outputSchema) as TSchema
      : Type.Unknown();

    return {
      name: tool.name,
      namespace: name,
      version: "1.0.0",
      type: OperationType.MUTATION,
      description: tool.description || "",
      tags: [],
      inputSchema: FromSchema(tool.inputSchema) as TSchema,
      outputSchema,
      accessControl: { requiredScopes: [] },
      handler: async (input: unknown) => {
        logger.debug(`Calling MCP tool: ${name}.${tool.name}`);
        const result = await client.callTool({
          name: tool.name,
          arguments: input as Record<string, unknown>,
        });

        const structuredContent = (result as any).structuredContent as Record<string, unknown> | undefined;
        const contentBlocks = Array.isArray(result.content) ? result.content : [];

        const isUnknownOutputSchema = outputSchema[Kind] === "Unknown" || (typeof outputSchema === "object" && Object.keys(outputSchema).filter(k => typeof k === "string").length === 0);

        const data = structuredContent
          ? (!isUnknownOutputSchema
            ? Value.Cast(outputSchema, structuredContent)
            : structuredContent)
          : mapMCPContentBlocks(contentBlocks);

        const meta: Omit<MCPResponseMeta, "source"> = {
          isError: Boolean(result.isError),
          content: mapMCPContentBlocks(contentBlocks),
        };
        if (structuredContent != null) {
          meta.structuredContent = structuredContent;
        }
        if ((result as any)._meta != null) {
          meta._meta = (result as any)._meta as Record<string, unknown>;
        }

        return mcpEnvelope(data, meta);
      },
    } satisfies OperationSpec & { handler: OperationHandler };
  });

  return {
    name,
    client,
    tools: operations,
  };
}

export async function closeMCPClient(wrapper: MCPClientWrapper): Promise<void> {
  logger.info(`Closing MCP client: ${wrapper.name}`);
  const client = wrapper.client as any;
  if (client && typeof client.close === "function") {
    await client.close();
  }
}

export class MCPClientLoader {
  private clients: Map<string, MCPClientWrapper> = new Map();

  async load(config: Record<string, MCPClientConfig>): Promise<MCPClientWrapper[]> {
    logger.info(`Loading ${Object.keys(config).length} MCP servers`);

    const wrappers: MCPClientWrapper[] = [];

    for (const [name, serverConfig] of Object.entries(config)) {
      try {
        const wrapper = await createMCPClient(name, serverConfig);
        this.clients.set(name, wrapper);
        wrappers.push(wrapper);
      } catch (error) {
        logger.error(`Failed to load MCP server ${name}: ${error}`);
        throw error;
      }
    }

    return wrappers;
  }

  getClient(name: string): MCPClientWrapper | undefined {
    return this.clients.get(name);
  }

  getAllWrappers(): MCPClientWrapper[] {
    return Array.from(this.clients.values());
  }

  getAllOperations(): Array<OperationSpec & { handler: OperationHandler }> {
    const allOps: Array<OperationSpec & { handler: OperationHandler }> = [];
    for (const wrapper of this.clients.values()) {
      for (const op of wrapper.tools) {
        allOps.push(op);
      }
    }
    return allOps;
  }

  async closeAll(): Promise<void> {
    logger.info(`Closing ${this.clients.size} MCP clients`);

    const closePromises = Array.from(this.clients.values()).map((wrapper) =>
      closeMCPClient(wrapper).catch((error) => {
        logger.error(`Error closing MCP client ${wrapper.name}: ${error}`);
      })
    );

    await Promise.all(closePromises);
    this.clients.clear();
  }
}