/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import type { ReadingFailure } from "./free-research.ts";

/** Parser revision is separate from prompt rules: diagnostic changes do not
 * require spending the reading budget on every stored article again. */
export const READING_PARSER_VERSION = 2;

export type ReadingRejection = "invalid_json" | "invalid_shape" | "unknown_citation"
  | "invalid_quote" | "missing_event_citation" | "invalid_project_basis";

/** No prompts, source text, model output or provider error bodies. */
export type ReadingAttempt = {
  provider: string | null;
  model: string | null;
  rules: number;
  parser: number;
  attempted: boolean;
  attempts: number;
  outcome: "accepted" | ReadingFailure;
  code: string | null;
};

export type GithubRequest = {
  repository: string;
  endpoint: "repository" | "commits" | "release";
  status: number | null;
  outcome: "ok" | "no_release" | "rate_limited" | "http_error" | "invalid_response" | "transport_error";
};

export type RefreshReliability = {
  version: 1;
  readings: Array<ReadingAttempt & { signalId: string | null; sourceId: string; sourceIds: string[] }>;
  github: GithubRequest[];
};
