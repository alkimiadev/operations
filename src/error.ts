export enum InfrastructureErrorCode {
  OPERATION_NOT_FOUND = "OPERATION_NOT_FOUND",
  ACCESS_DENIED = "ACCESS_DENIED",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  TIMEOUT = "TIMEOUT",
  ABORTED = "ABORTED",
  EXECUTION_ERROR = "EXECUTION_ERROR",
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

export type CallErrorCode = InfrastructureErrorCode | string;

export class CallError extends Error {
  readonly code: CallErrorCode;
  readonly details?: unknown;

  constructor(code: CallErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "CallError";
    this.code = code;
    this.details = details;
  }
}

export function mapError(
  error: unknown,
  errorSchemas?: { code: string; schema: unknown }[],
): CallError {
  if (error instanceof CallError) {
    return error;
  }

  if (error instanceof Error) {
    if (errorSchemas) {
      const message = error.message;
      for (const schema of errorSchemas) {
        if (message.startsWith(schema.code + ":") || message === schema.code) {
          return new CallError(schema.code, message, error);
        }
      }
    }

    return new CallError(InfrastructureErrorCode.EXECUTION_ERROR, error.message, error);
  }

  return new CallError(
    InfrastructureErrorCode.UNKNOWN_ERROR,
    String(error),
    { raw: String(error) },
  );
}