export const BRAND = {
  name: "Veyra",
  monogram: "V",
  tagline: "Trust Infrastructure for Agentic Commerce",
  description:
    "Verify agents and services, evaluate counterparties before money moves, independently evaluate ERC-8183 work, and turn completed interactions into verifiable reputation on Arc.",
  developerConsole: "Veyra Developer Console",
  agentApi: "Veyra Agent API",
  reports: "Veyra Reports",
} as const;

export const BRAND_TITLE = `${BRAND.name} — ${BRAND.tagline}`;

export function brandPageTitle(page: string) {
  return `${page} | ${BRAND.name}`;
}
