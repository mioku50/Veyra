export const BRAND = {
  name: "Veyra",
  monogram: "V",
  tagline: "Veyra decides. Circle pays.",
  description:
    "Before an agent spends USDC, Veyra decides whether it should pay, whom, and how much.",
  developerConsole: "Veyra Developer Console",
  agentApi: "Veyra Agent API",
  reports: "Veyra Reports",
} as const;

export const BRAND_TITLE = `${BRAND.name} — ${BRAND.tagline}`;

export function brandPageTitle(page: string) {
  return `${page} | ${BRAND.name}`;
}
