export type TraeCliErrorCode =
  | "configuration" | "inactive" | "integrity" | "authorization"
  | "unsupported_platform" | "unsupported_version" | "confinement"
  | "authentication" | "model_unavailable" | "rate_limit" | "quota"
  | "protocol" | "usage_missing" | "output_limit" | "input_limit"
  | "timeout" | "cancelled" | "cli_failed" | "isolation_violation";

const MESSAGES: Record<TraeCliErrorCode, string> = {
  configuration: "TRAE CLI transport configuration is invalid.",
  inactive: "The TRAE CLI extension is not active.",
  integrity: "The TRAE CLI extension or executable integrity check failed.",
  authorization: "An exact, active, single-use kernel transport lease is required.",
  unsupported_platform: "Verified TRAE CLI confinement is only supported on macOS.",
  unsupported_version: "This TRAE CLI version or its required flags are not supported.",
  confinement: "The required TRAE CLI OS confinement could not be established.",
  authentication: "TRAE CLI authentication is unavailable in the isolated transport.",
  model_unavailable: "TRAE CLI reports that the selected model is unavailable.",
  rate_limit: "TRAE CLI reports a rate limit.",
  quota: "TRAE CLI reports insufficient quota.",
  protocol: "TRAE CLI returned an unsupported or malformed transport response.",
  usage_missing: "TRAE CLI did not return measured token usage.",
  output_limit: "TRAE CLI exceeded the transport output limit.",
  input_limit: "The request exceeded the transport input limit.",
  timeout: "The TRAE CLI transport timed out.",
  cancelled: "The TRAE CLI transport was cancelled.",
  cli_failed: "The TRAE CLI process failed; raw diagnostics are withheld.",
  isolation_violation: "TRAE CLI attempted an activity outside model transport.",
};

export class TraeCliError extends Error {
  readonly code: TraeCliErrorCode;
  readonly retriable: boolean;
  constructor(code: TraeCliErrorCode) {
    super(MESSAGES[code]);
    this.name = "TraeCliError";
    this.code = code;
    this.retriable = code === "rate_limit" || code === "timeout";
  }
}
