/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

export type HumanizedErrorAction =
  | "switch_network"
  | "switch_wallet"
  | "refresh_price"
  | "open_agent"
  | "open_policy"
  | "retry";

export type HumanizedError = {
  title: string;
  message: string;
  action?: HumanizedErrorAction;
  actionLabel?: string;
  actionHref?: string;
  technicalCode?: string;
};

export function humanizeError(raw: unknown): HumanizedError {
  let messageStr = "";
  let reasonCode = "";

  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.reason === "string") {
      reasonCode = obj.reason;
    } else if (typeof obj.code === "string") {
      reasonCode = obj.code;
    }

    if (typeof obj.error === "string") {
      messageStr = obj.error;
    } else if (typeof obj.message === "string") {
      messageStr = obj.message;
    } else if (raw instanceof Error) {
      messageStr = raw.message;
    }
  } else if (raw instanceof Error) {
    messageStr = raw.message;
  } else if (typeof raw === "string") {
    messageStr = raw;
  } else {
    messageStr = String(raw ?? "");
  }

  if (messageStr === "[object Object]") {
    messageStr = "";
  }

  // GitHub error mappings
  if (
    reasonCode === "github_snapshot_unavailable" ||
    messageStr.includes("github_snapshot_unavailable") ||
    messageStr.includes("GitHub repository intelligence did not produce a valid snapshot")
  ) {
    return {
      title: "Repository analysis unavailable",
      message: "GitHub data was collected, but could not be passed to the analysis step. No charge was made for the failed analysis service.",
      technicalCode: "github_snapshot_unavailable",
    };
  }

  if (
    reasonCode === "agent_trust_input_required" ||
    messageStr.includes("Provide at least one Agent ID")
  ) {
    return {
      title: "Add an agent identifier",
      message: "Provide at least one public Agent ID, agent wallet, or GitHub repository.",
      technicalCode: "agent_trust_input_required",
    };
  }

  if (reasonCode === "agent_not_found" || messageStr.includes("public Agent ID")) {
    return {
      title: "Agent not found",
      message: "Check the public Veyra Agent ID. Unknown agents are not treated as negative evidence.",
      technicalCode: "agent_not_found",
    };
  }

  if (reasonCode === "invalid_wallet" || messageStr.includes("valid EVM address")) {
    return {
      title: "Invalid agent wallet",
      message: "Enter a valid public EVM wallet address.",
      technicalCode: "invalid_wallet",
    };
  }

  if (
    reasonCode === "contract_not_found" ||
    messageStr.includes("Arc Testnet contract address")
  ) {
    return {
      title: "Contract not found",
      message: "Check the Arc Testnet contract address, or remove it to continue without contract evidence.",
      technicalCode: "contract_not_found",
    };
  }

  if (
    reasonCode === "endpoint_private_network_blocked" ||
    messageStr.includes("private and local networks are blocked")
  ) {
    return {
      title: "Private endpoint blocked",
      message: "Use a public HTTPS endpoint. Localhost, private IPs, redirects to private networks, and internal hosts are blocked.",
      technicalCode: "endpoint_private_network_blocked",
    };
  }

  if (
    reasonCode === "endpoint_invalid" ||
    messageStr.includes("public HTTPS URL")
  ) {
    return {
      title: "Invalid service endpoint",
      message: "Check the service endpoint. It must be a public HTTPS URL.",
      technicalCode: "endpoint_invalid",
    };
  }

  if (
    reasonCode === "agent_trust_service_unavailable" ||
    messageStr.includes("canonical Arc report verification is disabled")
  ) {
    return {
      title: "Agent Trust Report temporarily unavailable",
      message:
        "Try again after the canonical report verification service becomes available.",
      action: "retry",
      actionLabel: "Try again",
      technicalCode: "agent_trust_service_unavailable",
    };
  }

  if (
    reasonCode === "invalid_github_repository" ||
    messageStr.includes("invalid_github_repository") ||
    messageStr.includes("Invalid GitHub repository")
  ) {
    return {
      title: "Invalid GitHub repository",
      message: "Enter a public repository in the format owner/repository.",
      technicalCode: "invalid_github_repository",
    };
  }

  if (
    reasonCode === "github_repository_not_found" ||
    messageStr.includes("github_repository_not_found") ||
    messageStr.includes("Repository not found")
  ) {
    return {
      title: "Repository not found",
      message: "Check the repository URL or confirm that the repository is public.",
      technicalCode: "github_repository_not_found",
    };
  }

  if (
    reasonCode === "github_repository_inaccessible" ||
    messageStr.includes("github_repository_inaccessible") ||
    messageStr.includes("Repository unavailable")
  ) {
    return {
      title: "Repository unavailable",
      message: "This report currently supports public GitHub repositories only.",
      technicalCode: "github_repository_inaccessible",
    };
  }

  if (
    reasonCode === "github_rate_limited" ||
    messageStr.includes("github_rate_limited") ||
    messageStr.includes("GitHub data is temporarily unavailable") ||
    messageStr.includes("GitHub data limit has been reached")
  ) {
    return {
      title: "GitHub data is temporarily unavailable",
      message: "The GitHub data limit has been reached. Try again later.",
      technicalCode: "github_rate_limited",
    };
  }

  if (
    reasonCode === "github_provider_timeout" ||
    messageStr.includes("github_provider_timeout") ||
    messageStr.includes("GitHub took too long to respond")
  ) {
    return {
      title: "GitHub took too long to respond",
      message: "No report was generated. Try again.",
      technicalCode: "github_provider_timeout",
    };
  }

  if (
    reasonCode === "github_repository_empty" ||
    messageStr.includes("github_repository_empty") ||
    messageStr.includes("Repository has no activity to analyze")
  ) {
    return {
      title: "Repository has no activity to analyze",
      message: "The repository exists, but no commits were found on its default branch.",
      technicalCode: "github_repository_empty",
    };
  }

  if (
    reasonCode === "workflow_services_unavailable" ||
    messageStr.includes("workflow_services_unavailable") ||
    messageStr.includes("required services are not enabled")
  ) {
    return {
      title: "Services unavailable",
      message: "This report is temporarily unavailable because its required services are not enabled.",
      technicalCode: "workflow_services_unavailable",
    };
  }

  if (
    reasonCode === "github_workflow_incomplete" ||
    messageStr.includes("github_workflow_incomplete") ||
    messageStr.includes("required analysis services are disabled")
  ) {
    return {
      title: "Services disabled",
      message: "GitHub Project Due Diligence is temporarily unavailable because required analysis services are disabled.",
      technicalCode: "github_workflow_incomplete",
    };
  }

  // Wallet already registered
  if (
    reasonCode === "wallet_already_registered" ||
    messageStr.includes("wallet_already_registered") ||
    messageStr.includes("already registered")
  ) {
    return {
      title: "Wallet already connected",
      message: "This wallet is already assigned to an agent. Open the existing agent or use another wallet.",
      action: "open_agent",
      actionLabel: "Open Agent",
      actionHref: "/console/agents",
      technicalCode: "wallet_already_registered",
    };
  }

  // Policy denied subcases
  if (
    reasonCode.startsWith("policy_denied") ||
    reasonCode === "policy_denied" ||
    messageStr.includes("policy_denied") ||
    messageStr.includes("Policy denied")
  ) {
    if (reasonCode.includes("workflow_not_allowed") || messageStr.includes("workflow_not_allowed") || messageStr.includes("not enabled")) {
      return {
        title: "Workflow disabled",
        message: "This workflow is not enabled for the selected agent.",
        action: "open_policy",
        actionLabel: "Open Spending Policy",
        actionHref: "/console/agents",
        technicalCode: "policy_denied:workflow_not_allowed",
      };
    }
    if (reasonCode.includes("service_type_not_allowed") || messageStr.includes("service_type_not_allowed") || messageStr.includes("Live Data")) {
      return {
        title: "Required service unavailable",
        message: "This workflow requires Live Data, but Live Data is disabled in the agent policy.",
        action: "open_policy",
        actionLabel: "Enable Live Data",
        actionHref: "/console/agents",
        technicalCode: "policy_denied:service_type_not_allowed",
      };
    }
    if (reasonCode.includes("max_run_exceeded") || messageStr.includes("max_run_exceeded") || messageStr.includes("maximum amount per run")) {
      return {
        title: "Price exceeds agent limit",
        message: "This report costs more than the agent's maximum amount per run.",
        action: "open_policy",
        actionLabel: "Update Limit",
        actionHref: "/console/agents",
        technicalCode: "policy_denied:max_run_exceeded",
      };
    }
    if (reasonCode.includes("daily_spend_exceeded") || messageStr.includes("daily_spend_exceeded") || messageStr.includes("daily USDC limit")) {
      return {
        title: "Daily spending limit reached",
        message: "The agent has reached its daily USDC limit. Increase the limit or try again tomorrow.",
        action: "open_policy",
        actionLabel: "Update Limit",
        actionHref: "/console/agents",
        technicalCode: "policy_denied:daily_spend_exceeded",
      };
    }
    if (reasonCode.includes("daily_calls_exceeded") || messageStr.includes("daily_calls_exceeded") || messageStr.includes("allowed calls for today")) {
      return {
        title: "Daily run limit reached",
        message: "The agent has used all allowed calls for today.",
        action: "open_policy",
        actionLabel: "Update Limit",
        actionHref: "/console/agents",
        technicalCode: "policy_denied:daily_calls_exceeded",
      };
    }
    return {
      title: "Action denied by agent policy",
      message: "The selected action violates the agent's active spending policy.",
      action: "open_policy",
      actionLabel: "Open Spending Policy",
      actionHref: "/console/agents",
      technicalCode: "policy_denied",
    };
  }

  // Wallet mismatch
  if (
    reasonCode === "wallet_mismatch" ||
    (messageStr.includes("wallet") &&
      (messageStr.includes("differs") || messageStr.includes("mismatch") || messageStr.includes("not the registered")))
  ) {
    return {
      title: "Switch wallet to continue",
      message: "The connected wallet is not the registered agent payment wallet. Open your wallet extension and select the registered account.",
      action: "switch_wallet",
      actionLabel: "How to Switch Wallet",
      technicalCode: "wallet_mismatch",
    };
  }

  // Wrong network
  if (
    reasonCode === "wrong_network" ||
    reasonCode === "unsupported_chain" ||
    reasonCode === "chain_mismatch" ||
    reasonCode === "arc_network_required" ||
    /wrong network|unsupported chain|chain mismatch/i.test(messageStr)
  ) {
    return {
      title: "Switch to Arc Testnet",
      message: "This action requires Arc Testnet.",
      action: "switch_network",
      actionLabel: "Switch Network",
      technicalCode: "wrong_network",
    };
  }

  // Quote expired
  if (
    reasonCode === "quote_expired" ||
    messageStr.includes("quote expired") ||
    messageStr.includes("Price expired") ||
    messageStr.includes("expired")
  ) {
    return {
      title: "Price expired",
      message: "Refresh the price before continuing. No payment has been made.",
      action: "refresh_price",
      actionLabel: "Refresh Price",
      technicalCode: "quote_expired",
    };
  }

  // Credential missing or revoked
  if (
    reasonCode === "credential_missing" ||
    messageStr.includes("credential") ||
    messageStr.includes("Credential")
  ) {
    return {
      title: "Active credential required",
      message: "Create a new API credential before running this external agent.",
      action: "open_agent",
      actionLabel: "Create Credential",
      actionHref: "/console/agents",
      technicalCode: "credential_missing",
    };
  }

  // Generic fallback
  const cleanedMessage = messageStr.replace(/\s*\([a-z0-9_]+\)$/i, "").trim();

  return {
    title: "Something went wrong",
    message: cleanedMessage || "The request could not be completed. Try again.",
    action: "retry",
    actionLabel: "Try Again",
    technicalCode: reasonCode || "generic_error",
  };
}
