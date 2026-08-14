/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const originalPath = resolve(root, "public/openapi/agent-commerce-v1.json");
const canonicalPath = resolve(root, "public/openapi/veyra-agent-api-v1.json");

const spec = JSON.parse(readFileSync(originalPath, "utf8"));

spec.info = {
  title: "Veyra Agent API",
  version: "0.1.0-beta.2",
  description:
    "Machine API for Veyra on Arc Testnet — verified workflows, evidence-weighted agent reputation, Trust Gate policy decisions, counterparty selection, ERC-8183 independent evaluation, continuous trust monitoring, and Project 360.",
  contact: {
    name: "Veyra Team",
    url: "https://github.com/mioku50/Veyra",
  },
  license: {
    name: "Apache-2.0",
    url: "https://www.apache.org/licenses/LICENSE-2.0.html",
  },
};

spec.servers = [
  {
    url: "https://agent-commerce-six.vercel.app",
    description: "Arc Testnet Live Production Server",
  },
  {
    url: "http://localhost:3000",
    description: "Local Development Server",
  },
];

// Add Status endpoint
spec.paths["/api/status"] = {
  get: {
    summary: "Public Health & Network Status",
    description: "Returns sanitized operational health, active Arc Testnet chain ID, and current public beta version.",
    operationId: "getPublicStatus",
    security: [],
    responses: {
      "200": {
        description: "Operational status",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                status: { type: "string", example: "operational" },
                network: { type: "string", example: "arc-testnet" },
                chainId: { type: "integer", example: 5042002 },
                version: { type: "string", example: "0.1.0-beta.1" },
                timestamp: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
    },
  },
};

// Add Trust Gate Decisions
spec.paths["/api/trust/v1/decisions"] = {
  post: {
    summary: "Evaluate Trust Gate Decision",
    description: "Evaluates a pre-transaction policy check and issues an EIP-712 signed clearance ticket if approved (ALLOW / ALLOW_WITH_LIMITS / REQUIRE_EVALUATOR / REVIEW_REQUIRED / DENY).",
    operationId: "evaluateTrustDecision",
    security: [],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["subjectAgentId", "action", "requestedValueUsdc"],
            properties: {
              subjectAgentId: { type: "string", description: "Target Agent ID or counterparty identifier" },
              action: { type: "string", description: "Operation name or contract method", example: "erc8183_job_settlement" },
              requestedValueUsdc: { type: "number", description: "Value of the transaction in USDC", example: 5.0 },
              executorWallet: { type: "string", description: "Wallet executing the transaction on Arc Testnet", example: "0x0000000000000000000000000000000000000001" },
              targetContract: { type: "string", description: "Destination smart contract address on Arc" },
              metadata: { type: "object", description: "Optional transaction context metadata" },
            },
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Trust decision with optional signed clearance ticket",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                decision: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    decision: { type: "string", enum: ["ALLOW", "ALLOW_WITH_LIMITS", "REQUIRE_EVALUATOR", "REVIEW_REQUIRED", "DENY"] },
                    reason: { type: "string" },
                    rulesTriggered: { type: "array", items: { type: "string" } },
                    confidence: { type: "string" },
                    createdAt: { type: "string", format: "date-time" },
                  },
                },
                clearance: {
                  type: "object",
                  description: "EIP-712 clearance message consumable by VeyraTrustGate contract",
                },
                signature: { type: "string", description: "EIP-712 signature over the clearance message" },
              },
            },
          },
        },
      },
      "400": { description: "Invalid input parameters" },
      "503": { description: "Trust decision service temporarily unavailable" },
    },
  },
};

// Add Counterparty Discovery
spec.paths["/api/trust/v1/counterparties/discover"] = {
  get: {
    summary: "Discover Eligible Counterparties",
    description: "Queries active and registered counterparties on Arc Testnet matching service capabilities or tags.",
    operationId: "discoverCounterparties",
    security: [],
    parameters: [
      {
        name: "capability",
        in: "query",
        required: false,
        schema: { type: "string" },
        description: "Filter by capability or workflow type",
      },
      {
        name: "minReputation",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 0, maximum: 100 },
        description: "Minimum trust score threshold",
      },
    ],
    responses: {
      "200": {
        description: "List of matching counterparties",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                counterparties: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      agentId: { type: "string" },
                      name: { type: "string" },
                      walletAddress: { type: "string" },
                      reputationScore: { type: "integer" },
                      capabilities: { type: "array", items: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

// Add Counterparty Selection
spec.paths["/api/trust/v1/counterparties/select"] = {
  post: {
    summary: "Select Optimal Counterparty",
    description: "Evaluates and ranks candidate counterparties using multi-criteria optimization across reputation, execution reliability, latency, and budget constraints.",
    operationId: "selectCounterparty",
    security: [],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["candidates"],
            properties: {
              taskType: { type: "string", example: "github_due_diligence" },
              budgetUsdc: { type: "number", example: 10.0 },
              minConfidence: { type: "string", example: "Medium" },
              candidates: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    agentId: { type: "string" },
                    wallet: { type: "string" },
                    quotedPriceUsdc: { type: "number" },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Selection ranking and recommendation",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                selectionId: { type: "string" },
                selectedAgentId: { type: "string" },
                selectedCandidate: { type: "object" },
                rankings: { type: "array", items: { type: "object" } },
                selectionScore: { type: "number" },
                rationale: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

// Add Selection Retrieval
spec.paths["/api/trust/v1/selections/{selectionId}"] = {
  get: {
    summary: "Retrieve Selection Result",
    description: "Retrieves a previously computed counterparty selection by ID, including ranking details and proof hashes.",
    operationId: "getSelectionResult",
    security: [],
    parameters: [
      {
        name: "selectionId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      "200": {
        description: "Saved selection result",
      },
      "404": {
        description: "Selection not found",
      },
    },
  },
};

// Add Selection Clearance
spec.paths["/api/trust/v1/selections/{selectionId}/clearance"] = {
  post: {
    summary: "Get Signed Trust Clearance for Selection",
    description: "Generates an EIP-712 signed clearance ticket for the chosen candidate in a selection result, allowing onchain execution.",
    operationId: "getSelectionClearance",
    security: [],
    parameters: [
      {
        name: "selectionId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      "200": {
        description: "Signed clearance ticket",
      },
      "400": { description: "Selection is not executable" },
      "404": { description: "Selection not found" },
    },
  },
};

const formatted = JSON.stringify(spec, null, 2) + "\n";

writeFileSync(canonicalPath, formatted, "utf8");
writeFileSync(originalPath, formatted, "utf8");

console.log("[rebrand-openapi] updated veyra-agent-api-v1.json and agent-commerce-v1.json");
