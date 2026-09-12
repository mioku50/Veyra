/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextRequest, NextResponse } from "next/server.js";
import { authenticateMachineRequest } from "../../../../../lib/api/machine-auth.ts";
import { curatedHostedWorkflowTemplates } from "../../../../../lib/agent/workflow-templates.ts";
import { ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC_ADDRESS } from "../../../../../lib/wallet/arc.ts";
import { API_QUALITY_FINALIZER_PRICE_USDC } from "../../../../../lib/services/constants.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function buildInputSchema(workflowType: string) {
  if (workflowType === "project_360") {
    return {
      type: "object",
      description:
        "Project 360 uses free discovery followed by explicit candidate selection; it cannot be quoted through the generic quote endpoint.",
      properties: {
        type: {
          type: "string",
          enum: [
            "github_repository",
            "project_wallet",
            "agent_id",
            "arc_contract",
            "public_api_endpoint",
          ],
        },
        value: { type: "string", minLength: 1, maxLength: 2048 },
      },
      required: ["type", "value"],
    };
  }
  if (workflowType === "agent_trust_report") {
    return {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          pattern: "^agt_[a-z0-9]{20}$",
          description: "Public Veyra Agent ID",
        },
        agentWallet: {
          type: "string",
          pattern: "^0x[0-9a-fA-F]{40}$",
          description: "Public EVM wallet associated with the agent",
        },
        repositoryUrl: {
          type: "string",
          description: "Public GitHub repository in owner/repo or URL format",
        },
        contractAddress: {
          type: "string",
          pattern: "^0x[0-9a-fA-F]{40}$",
          description: "Optional Arc Testnet contract address",
        },
        serviceEndpoint: {
          type: "string",
          format: "uri",
          description:
            "Optional public HTTPS endpoint; private and local networks are blocked",
        },
      },
      anyOf: [
        { required: ["agentId"] },
        { required: ["agentWallet"] },
        { required: ["repositoryUrl"] },
      ],
    };
  }

  if (workflowType === "github_due_diligence") {
    return {
      type: "object",
      properties: {
        repository: {
          type: "string",
          description: "GitHub repository in owner/repo format or full URL (e.g., circlefin/agent-commerce)",
        },
      },
      required: ["repository"],
    };
  }

  if (workflowType === "treasury_health") {
    return {
      type: "object",
      properties: {
        walletAddress: {
          type: "string",
          pattern: "^0x[0-9a-fA-F]{40}$",
          description: "Public EVM wallet address to analyze",
        },
      },
      required: ["walletAddress"],
    };
  }

  if (workflowType === "market_context") {
    return {
      type: "object",
      properties: {
        marketSymbol: {
          type: "string",
          enum: ["BTC/USD", "ETH/USD", "SOL/USD"],
          description: "Crypto market pair to evaluate",
        },
        text: {
          type: "string",
          description: "Market analysis question or context notes",
        },
      },
      required: ["marketSymbol"],
    };
  }

  return {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Text input for analysis and processing",
      },
    },
    required: ["text"],
  };
}

export async function GET(request: NextRequest) {
  const authResult = await authenticateMachineRequest(request, "workflows:read");
  if (!authResult.ok) {
    return authResult.response;
  }

  const { context } = authResult;
  const allowedSet = new Set(context.allowedWorkflows || []);

  const templates = curatedHostedWorkflowTemplates
    .filter((template) => allowedSet.has("*") || allowedSet.has(template.value))
    .map((template) => ({
      id: template.value,
      name: template.label,
      shortName: template.shortLabel,
      description: template.description,
      task: template.task,
      estimatedUsdc: template.estimatedSpendUsdc,
      inputSchema: buildInputSchema(template.value),
      quoteFlow:
        template.value === "project_360"
          ? {
              discovery: "/api/agent/v1/project-360/discoveries",
              quote:
                "/api/agent/v1/project-360/discoveries/{discoveryId}/quote",
              execution: "/api/agent/v1/runs",
              candidateSelectionRequired: true,
            }
          : {
              quote: "/api/agent/v1/quotes",
              execution: "/api/agent/v1/runs",
              candidateSelectionRequired: false,
            },
      arc: {
        chainId: ARC_TESTNET_CHAIN_ID,
        network: "arc-testnet",
        asset: "USDC",
        tokenAddress: ARC_TESTNET_USDC_ADDRESS,
      },
    }));

  return NextResponse.json(
    {
      version: "1",
      workflows: templates,
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
