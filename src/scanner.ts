import type { IOperationDefinition } from "./types.js";
import { OperationDefinitionSchema } from "./types.js";
import { collectErrors, formatValueErrors } from "./validation.js";
import { getLogger } from "@logtape/logtape";

const logger = getLogger("operations:scanner");

export interface ScannerFS {
  readdir(path: string): AsyncIterable<{ name: string; isFile: boolean; isDirectory: boolean }>;
  cwd(): string;
}

export interface OperationManifest {
  operations: Record<string, IOperationDefinition>;
  baseUrl?: string;
}

export async function scanOperations(
  dirPath: string,
  fs: ScannerFS,
): Promise<IOperationDefinition[]> {
  const operations: IOperationDefinition[] = [];

  try {
    await processDirectory(dirPath, operations, fs);
  } catch (error) {
    logger.error(
      `Error scanning directory ${dirPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  }

  return operations;
}

async function processDirectory(
  dirPath: string,
  operations: IOperationDefinition[],
  fs: ScannerFS,
): Promise<void> {
  try {
    for await (const entry of fs.readdir(dirPath)) {
      const fullPath = `${dirPath}/${entry.name}`;

      if (entry.isDirectory) {
        await processDirectory(fullPath, operations, fs);
      } else if (entry.isFile && entry.name.endsWith(".ts")) {
        try {
          const absolutePath = fullPath.startsWith("/") ? fullPath : `${fs.cwd()}/${fullPath}`;
          const moduleUrl = pathToFileURL(absolutePath);
          const module = await import(moduleUrl);

          if (module.default) {
            const operation = module.default as IOperationDefinition;

            const errors = collectErrors(OperationDefinitionSchema, operation);

            if (errors.length > 0) {
              logger.warn(`${fullPath}: Invalid operation definition - ${formatValueErrors(errors, "")}`);
              continue;
            }

            operations.push(operation);
            logger.info(
              `Loaded operation: ${operation.namespace}.${operation.name} from ${fullPath}`,
            );
          } else {
            logger.warn(`${fullPath} does not export a default operation`);
          }
        } catch (error) {
          logger.error(
            `Error processing ${fullPath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  } catch (error) {
    logger.error(
      `Error reading directory ${dirPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw new Error(
      `Failed to process directory ${dirPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function pathToFileURL(absolutePath: string): string {
  return `file://${absolutePath}`;
}