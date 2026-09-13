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
 * Four links, in the order a person needs them.
 *
 * This list had eight items across four headed sections, which asked a visitor
 * to learn Veyra's architecture -- run, activity, network, evidence -- before
 * they could use any of it. The deeper screens still exist and are still
 * reachable from the thing they belong to; they are just no longer presented as
 * co-equal destinations to someone who has not made a single decision yet.
 *
 * The brief is the product. Everything below it is how the brief is justified.
 */
export const publicSidebarNavigation = [
  {
    label: "Your agent",
    items: [
      { href: "/", label: "Daily brief", icon: "agent" },
    ],
  },
  {
    label: "History",
    items: [
      { href: "/executions", label: "Decisions", icon: "activity" },
      /* "Receipts" is on the forbidden-jargon list the public UI check
         enforces, and rightly: a person looking for what they were charged does
         not go hunting for a receipts subsystem. */
      { href: "/receipts", label: "Payments", icon: "receipt" },
    ],
  },
  {
    label: "Advanced",
    items: [
      { href: "/run", label: "Choose and pay yourself", icon: "activity" },
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
