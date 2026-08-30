export type LlmFailureReason =
  | "not_configured"
  | "unsupported_provider"
  | "no_paid_api_results"
  | "timeout"
  | "rate_limited"
  | "upstream_error"
  | "response_too_large"
  | "invalid_response";

export type LlmPaidApiReference = {
  serviceSlug: string;
  serviceName: string;
  amountUsdc: string | null;
};

export type HostedReportSynthesis = {
  status: "ai_generated" | "deterministic_fallback";
  provider: "StepFun" | null;
  protocol: "openai-compatible" | null;
  model: string | null;
  attempted: boolean;
  usedPaidApiResponses: LlmPaidApiReference[];
  fallbackReason: LlmFailureReason | null;
  generatedAt: string | null;
};
