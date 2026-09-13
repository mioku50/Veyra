/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { isAddress } from "viem";
import { authenticateSelectionRequest } from "@/lib/counterparty-selection/auth";
import {
  gatewayContextForChain,
  gatewayDepositSteps,
  readGatewayBalance,
  readWalletUsdc,
} from "@/lib/x402/gateway-deposit";

export const dynamic = "force-dynamic";

/**
 * Answers whether this wallet can actually pay a Circle Gateway endpoint, and
 * hands back the calldata to fix it when it cannot.
 *
 * A batched accept spends a Gateway deposit, not the wallet's USDC balance, so
 * a funded wallet is refused and the refusal looks like a fault. Veyra knew
 * this and printed it as prose next to a dead end. Asking before the signature
 * costs nothing, and the answer is the difference between "your purchase
 * failed" and "deposit 0.05 and continue".
 *
 * This route holds no key. It reads public chain state and Circle's public
 * balances API, and returns unsigned transactions for the buyer's own wallet.
 */

/** A deposit ceiling, so a bug upstream cannot put a large number in a wallet. */
const MAX_DEPOSIT_USDC = 5;

function badRequest(code: string, message: string, status = 400) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: NextRequest) {
  const auth = await authenticateSelectionRequest(request, "quotes:create");
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return badRequest("invalid_body", "A JSON body is required.");
  }

  const chainId = Number(body.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return badRequest("chain_invalid", "A chain id is required.");
  }

  const wallet = typeof body.wallet === "string" ? body.wallet : "";
  if (!isAddress(wallet)) return badRequest("wallet_invalid", "A wallet address is required.");

  const requiredAtomic = typeof body.requiredAtomic === "string" && /^\d+$/.test(body.requiredAtomic)
    ? BigInt(body.requiredAtomic)
    : BigInt(0);

  const context = gatewayContextForChain(chainId);
  if (!context) {
    return NextResponse.json({
      supported: false,
      chainId,
      message: `Circle Gateway is not deployed on chain ${chainId}, so nothing can be deposited there.`,
    }, { headers: { "Cache-Control": "no-store" } });
  }

  const [gateway, onChain] = await Promise.all([
    readGatewayBalance(context, wallet),
    readWalletUsdc(context, wallet as `0x${string}`),
  ]);

  /* Unknown is reported as unknown. Telling a reader their Gateway balance is
     zero because Circle timed out would send them to fund an account that is
     already funded, and a deposit is not refundable by pressing back. */
  const gatewayAvailable = gateway?.availableAtomic ?? null;
  const sufficient = gatewayAvailable === null ? null : gatewayAvailable >= requiredAtomic;

  /* What to suggest depositing. Enough to cover this call many times over, so
     the reader is not sent back through two transactions for the next one —
     but never more than they hold, and never above the ceiling. */
  const walletBalance = onChain?.balanceAtomic ?? BigInt(0);
  const shortfall = gatewayAvailable === null
    ? requiredAtomic
    : requiredAtomic > gatewayAvailable ? requiredAtomic - gatewayAvailable : BigInt(0);
  const requested = typeof body.depositUsdc === "number" && Number.isFinite(body.depositUsdc)
    ? BigInt(Math.floor(Math.min(Math.max(body.depositUsdc, 0), MAX_DEPOSIT_USDC) * 1e6))
    : null;
  const suggested = requested ?? (shortfall > BigInt(50_000) ? shortfall : BigInt(50_000));
  const depositAtomic = walletBalance < suggested ? walletBalance : suggested;

  const canDeposit = depositAtomic > BigInt(0) && depositAtomic >= shortfall;

  return NextResponse.json({
    supported: true,
    chainId,
    domain: context.domain,
    gatewayWallet: context.gatewayWallet,
    usdc: context.usdc,
    testnet: context.testnet,
    requiredAtomic: requiredAtomic.toString(),
    // Null where the question could not be asked, never silently zero.
    gatewayAvailableAtomic: gatewayAvailable === null ? null : gatewayAvailable.toString(),
    gatewayPendingAtomic: gateway?.pendingAtomic.toString() ?? null,
    walletUsdcAtomic: onChain ? onChain.balanceAtomic.toString() : null,
    allowanceAtomic: onChain ? onChain.allowanceAtomic.toString() : null,
    sufficient,
    depositAtomic: depositAtomic.toString(),
    canDeposit,
    // Nothing to sign when the balance already covers it.
    steps: sufficient === true || !canDeposit || !onChain
      ? []
      : gatewayDepositSteps({
          context,
          depositAtomic,
          allowanceAtomic: onChain.allowanceAtomic,
        }),
    message: sufficient === true
      ? "Your Gateway balance covers this call."
      : gatewayAvailable === null
        ? "Circle did not answer, so your Gateway balance is unknown. Try again before depositing."
        : walletBalance < shortfall
          ? `This wallet holds ${(Number(walletBalance) / 1e6).toFixed(6)} USDC on this chain, which is not enough to cover the deposit.`
          : "Deposit USDC into Circle Gateway to pay this endpoint.",
  }, { headers: { "Cache-Control": "no-store" } });
}
