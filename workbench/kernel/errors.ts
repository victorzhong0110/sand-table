import type { ErrorCode } from "./types.ts";

export class CommandError extends Error {
  code: ErrorCode;
  commandIndex: number | null;
  details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    commandIndex: number | null = null,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.commandIndex = commandIndex;
    if (details !== undefined) this.details = details;
  }
}
