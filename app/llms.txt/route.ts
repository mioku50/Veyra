/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { BRAND } from "@/lib/brand";
import { VEYRA_ORIGIN } from "@/lib/erc8004/veyra-registration";
import { ARC_OPENAPI_PATH, ARC_TRUST_API } from "@/lib/x402/trust-api/arc-mainnet";

export function GET() {
  const origin = VEYRA_ORIGIN;
  return new Response([
    `# ${BRAND.name}`,
    "",
    "> Read payment terms and trust evidence for x402 endpoints on Arc Mainnet.",
    "",
    "## Trust API and MCP",
    "",
    `- [Trust API OpenAPI](${origin}${ARC_OPENAPI_PATH}): request and response schemas.`,
    `- [Free verdict](${origin}/api/x402/v1/verdict): POST a resource URL to inspect its live HTTP 402.`,
    `- [Endpoint history](${origin}${ARC_TRUST_API.history.path}): paid x402 history on Arc Mainnet.`,
    `- [MCP](${origin}/api/mcp): Streamable HTTP for verdict, history summary and resource discovery.`,
    `- [Arc endpoints](${origin}/check): public catalogue and unpaid check results.`,
    `- [State of Arc x402](${origin}/state): observed Arc Mainnet x402 market metrics and methodology.`,
    `- [State of Arc x402 JSON](${origin}/state.json): machine-readable snapshot of observed Arc x402 metrics.`,
    `- [Agent manifest](${origin}/.well-known/veyra-agent.json): ${BRAND.name}'s public identity and capabilities.`,
    "",
  ].join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
