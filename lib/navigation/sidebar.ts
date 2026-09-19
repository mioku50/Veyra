export type SidebarIconName =
  | "activity"
  | "agent"
  | "my-agents"
  | "monitoring"
  | "console"
  | "dashboard"
  | "passport"
  | "project-360"
  | "proof"
  | "receipt"
  | "results"
  | "seller"
  | "templates"
  | "tools";

export const publicSidebarNavigation = [
  {
    label: "Your agent",
    items: [
      { href: "/", label: "Today", icon: "agent" },
      { href: "/agent", label: "My Agent", icon: "my-agents" },
      { href: "/memory", label: "Memory", icon: "results" },
      { href: "/arc", label: "Identity & Trust", icon: "passport" },
    ],
  },
] as const satisfies ReadonlyArray<{
  label: string;
  items: ReadonlyArray<{ href: string; label: string; icon: SidebarIconName }>;
}>;

export const consoleSidebarNavigation = [
  {
    label: BRAND.developerConsole,
    items: [
      { href: "/console", label: "Console Home", icon: "console" },
      { href: "/console/agent-api", label: BRAND.agentApi, icon: "agent" },
      { href: "/console/agents", label: "Agent Credentials", icon: "my-agents" },
      { href: "/console/operations", label: "Operations", icon: "activity" },
      { href: "/console/audit", label: "Audit & Verification", icon: "proof" },
      { href: "/console/developer-tools", label: "Developer Tools", icon: "tools" },
    ],
  },
  {
    /* Moved out of the public navigation. An execution ledger, a payments list
       and a counterparty picker are operator tools: useful, demonstrative of the
       engine, and not what somebody reading a morning brief is looking for. */
    label: "Buying and history",
    items: [
      { href: "/executions", label: "Decisions", icon: "activity" },
      { href: "/receipts", label: "Payments", icon: "receipt" },
      { href: "/run", label: "Manual purchase", icon: "activity" },
    ],
  },
  {
    // The stages of a decision, kept together where an operator looks for them
    // rather than spread across the product navigation.
    label: "Decision internals",
    items: [
      { href: "/trust/select", label: "Counterparties", icon: "proof" },
      { href: "/trust-gate", label: "Trust Gate", icon: "passport" },
      { href: "/trust/mandates", label: "Mandates", icon: "passport" },
      { href: "/evaluators", label: "Evaluator", icon: "proof" },
      { href: "/reputation", label: "Agent Trust", icon: "agent" },
    ],
  },
  {
    label: "Evidence tools",
    items: [
      { href: "/results", label: "Reports", icon: "results" },
      { href: "/agent-runner", label: "New Report", icon: "templates" },
      { href: "/project-360", label: "Project 360", icon: "project-360" },
      { href: "/monitoring", label: "Monitoring", icon: "monitoring" },
    ],
  },
] as const satisfies ReadonlyArray<{
  label: string;
  items: ReadonlyArray<{ href: string; label: string; icon: SidebarIconName }>;
}>;

export const sidebarNavigation = publicSidebarNavigation;

// overflow-y alone computes overflow-x to `auto`, which is why the sidebar grew
// a horizontal scrollbar as well as a vertical one. Both axes are stated.
export const DESKTOP_SIDEBAR_SCROLL_CLASS = "overflow-y-auto overflow-x-hidden overscroll-contain";
export const MOBILE_SIDEBAR_SCROLL_CLASS = "overflow-y-auto overflow-x-hidden overscroll-contain";
import { BRAND } from "../brand.ts";

export const publicLinks = publicSidebarNavigation.flatMap(section => section.items);
export const secondaryLinks = [
  { href: "/run", label: "Manual purchase" },
  { href: "/executions", label: "Decisions" },
  { href: "/console", label: BRAND.developerConsole },
] as const;
