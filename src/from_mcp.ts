import type { IOperationDefinition } from "./types.js";
import { OperationType } from "./types.js";
import { Type, type TSchema } from "@alkdev/typebox";
import { FromSchema } from "./from_schema.js";
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
  tools: IOperationDefinition[];
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
    throw new Error(`Invalid MCP server config for ${name}: must have either 'url' or 'command'`);
  }

  await client.connect(transport);
  logger.info(`Connected to MCP server: ${name}`);

  const toolsResult = await client.listTools();
  const operations: IOperationDefinition[] = toolsResult.tools.map((tool: { name: string; description?: string; inputSchema: unknown }) => {
    return {
      name: tool.name,
      namespace: name,
      version: "1.0.0",
      type: OperationType.MUTATION,
      description: tool.description || "",
      tags: [],
      inputSchema: FromSchema(tool.inputSchema) as TSchema,
      outputSchema: Type.Unknown(),
      accessControl: { requiredScopes: [] },
      handler: async (input: unknown) => {
        logger.debug(`Calling MCP tool: ${name}.${tool.name}`);
        const result = await client.callTool({
          name: tool.name,
          arguments: input as Record<string, unknown>,
        });

        if (result.isError) {
          throw new Error(`MCP tool error: ${JSON.stringify(result.content)}`);
        }

        return result.content;
      },
    } satisfies IOperationDefinition;
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

  getAllOperations(): IOperationDefinition[] {
    const allOps: IOperationDefinition[] = [];
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