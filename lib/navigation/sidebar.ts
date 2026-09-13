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

// Five destinations, not twelve.
//
// Selections, Mandates, Trust Gate, Evaluator, Monitoring and Project 360 are
// stages and inputs of a single decision, not places to go. Listing them as
// co-equal top-level items asked the visitor to learn the architecture before
// they could use the product, and it is what made the shell read as an internal
// admin panel next to a screen carrying the product tagline.
//
// They are not orphaned: each one moves into the developer console below, and
// each is reachable from the decision it belongs to.
export const publicSidebarNavigation = [
  /* Your agent leads, and the manual decision screen sits under it as the
     advanced path. Veyra's own screens answer many questions at once; a person
     arriving for the first time has exactly one -- what changed, and is any of
     it worth a cent -- and that is what the first item should open. */
  {
    label: "Your agent",
    items: [
      { href: "/nova", label: "Daily brief", icon: "agent" },
    ],
  },
  {
    label: "Run",
    items: [
      { href: "/run", label: "New decision", icon: "activity" },
    ],
  },
  {
    label: "Activity",
    items: [
      { href: "/executions", label: "Decisions", icon: "activity" },
      { href: "/receipts", label: "Receipts", icon: "receipt" },
    ],
  },
  {
    label: "Network",
    items: [
      { href: "/agents", label: "Agents", icon: "agent" },
      { href: "/trust", label: "Evidence", icon: "proof" },
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
    // The stages of a decision, kept together where an operator looks for them
    // rather than spread across the product navigation.
    label: "Decision internals",
    items: [
      { href: "/trust/select", label: "Counterparty Selection", icon: "proof" },
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
