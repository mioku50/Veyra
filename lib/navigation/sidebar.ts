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
/**
 * Four destinations, and all four are the agent.
 *
 * What was here before -- Daily brief, Decisions, Payments, Choose and pay
 * yourself -- described a product for buying APIs with three of its four links,
 * over a page that is a personal agent's morning brief. A person who has just
 * been told an agent watches things for them was being offered a payments
 * ledger and a counterparty picker as the next places to go.
 *
 * These four are the life of that agent instead: what changed today, what it
 * is and watches, what it has learned about you, and what it has earned on Arc.
 * Buying is not a destination in it. When Nova wants to pay for something it
 * says so on the item, with a price and a verdict, and that is the whole of it.
 *
 * The old screens are not gone. They moved into the developer console, which is
 * where an execution ledger and a counterparty picker have always belonged.
 */
export const publicSidebarNavigation = [
  {
    label: "Your agent",
    items: [
      { href: "/", label: "Today", icon: "agent" },
      { href: "/agent", label: "My Agent", icon: "my-agents" },
      { href: "/memory", label: "Memory", icon: "results" },
      { href: "/arc", label: "Arc", icon: "passport" },
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
      { href: "/run", label: "Choose and pay yourself", icon: "activity" },
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
