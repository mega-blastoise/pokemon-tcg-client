/** @module tcg_errors Defines stable failures without conflating missing records with errors. */

/** Branch on these codes rather than matching human-readable error messages. */
export type TCGErrorCode =
  | "CONFIGURATION"
  | "DATA_PACKAGE_MISSING"
  | "UNSUPPORTED_RUNTIME"
  | "UNSUPPORTED_SCHEMA"
  | "SNAPSHOT_MISMATCH"
  | "INVALID_DATA"
  | "INVALID_QUERY"
  | "FETCH_FAILED"
  | "ABORTED"
  | "DATABASE_FAILED"
  | "CLIENT_CLOSED";

/** Shared operational error; successful lookups of absent records return null instead. */
export class TCGError extends Error {
  /** Stable failure category across all runtime adapters. */
  readonly code: TCGErrorCode;
  /** HTTP response status when a fetch failed after reaching the server. */
  readonly status: number | undefined;

  /** Retain the original failure as cause without exposing adapter-specific error types. */
  constructor(
    code: TCGErrorCode,
    message: string,
    options: { cause?: unknown; status?: number } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "TCGError";
    this.code = code;
    this.status = options.status;
  }
}
