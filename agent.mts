/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { generatePrivateKey } from "viem/accounts";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { executeBuyerAgent } from "./lib/agent/execution.ts";
import {
  DEFAULT_AGENT_BUDGET_USDC,
  DEFAULT_AGENT_TASK,
} from "./lib/agent/planner.ts";
import { toErrorMessage } from "./lib/agent/fetch-with-retry.ts";

type CliArgs = {
  task: string;
  spendingLimit: number;
};

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let spendingLimit: number | null = null;
  let task = DEFAULT_AGENT_TASK;

  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--limit" && args[index + 1]) {
      const value = Number(args[++index]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--limit must be a positive number (USDC amount).");
      }
      spendingLimit = value;
    } else if (args[index] === "--task" && args[index + 1]) {
      task = args[++index].trim();
      if (!task) throw new Error("--task must not be empty.");
    } else if (args[index] === "--mode" && args[index + 1]) {
      const mode = args[++index].trim();
      if (mode !== "scripted") {
        throw new Error("Only --mode scripted is supported.");
      }
    } else {
      throw new Error(`Unknown or incomplete argument: ${args[index]}`);
    }
  }

  return {
    task,
    spendingLimit: spendingLimit ?? DEFAULT_AGENT_BUDGET_USDC,
  };
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}. Add it to .env.local before running npm run agent.`);
  }
  return value;
}

function requireAddress(name: string): Address {
  const value = requireEnv(name);
  if (!isAddress(value)) throw new Error(`${name} must be a valid EVM address.`);
  return getAddress(value);
}

function privateKey(name: string, required: true): Hex;
function privateKey(name: string, required: false): Hex | null;
function privateKey(name: string, required: boolean) {
  const value = process.env[name]?.trim();
  if (!value && !required) return null;
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte 0x-prefixed private key.`);
  }
  return value as Hex;
}

function positiveNumberEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return value;
}

function booleanEnv(name: string) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

async function main() {
  const args = parseArgs();
  const configuredAgentKey = privateKey("AGENT_PRIVATE_KEY", false);
  const skipFunding = booleanEnv("AGENT_SKIP_FUNDING");
  const skipDeposit = booleanEnv("AGENT_SKIP_DEPOSIT");

  if ((skipFunding || skipDeposit) && !configuredAgentKey) {
    throw new Error("AGENT_SKIP_FUNDING and AGENT_SKIP_DEPOSIT require AGENT_PRIVATE_KEY.");
  }

  await executeBuyerAgent({
    task: args.task,
    spendingLimit: args.spendingLimit,
    baseUrl: requireEnv("BASE_URL"),
    sellerAddress: requireAddress("SELLER_ADDRESS"),
    agentPrivateKey: configuredAgentKey ?? generatePrivateKey(),
    walletSource: configuredAgentKey ? "AGENT_PRIVATE_KEY" : "generated",
    funderPrivateKey: privateKey("BUYER_PRIVATE_KEY", true),
    funderAddress: requireAddress("BUYER_ADDRESS"),
    depositAmountUsdc: process.env.AGENT_DEPOSIT_USDC?.trim() || "1",
    fetchRetries: positiveNumberEnv("AGENT_FETCH_RETRIES", 3),
    fetchTimeoutMs: positiveNumberEnv("AGENT_FETCH_TIMEOUT_MS", 30_000),
    postDepositWaitMs: positiveNumberEnv("AGENT_POST_DEPOSIT_WAIT_MS", 0),
    skipFunding,
    skipDeposit,
    writeLocalRunLog: true,
    installSignalHandler: true,
    requirePersistence: false,
  });
}

main().catch((error) => {
  console.error(`Agent failed: ${toErrorMessage(error)}`);
  process.exitCode = 1;
});
