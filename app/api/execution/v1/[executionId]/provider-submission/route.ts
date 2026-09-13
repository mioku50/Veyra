import { NextRequest, NextResponse } from "next/server";
import { getExecutionAttempt, updateExecutionAttemptState } from "@/lib/execution/db";
import { verifyMessage } from "viem";

/**
 * The domain separator a provider signs over. It is a protocol constant, not
 * product copy: providers sign this exact string in their own clients, and every
 * signature already issued was made over it. Routing it through BRAND would make
 * a rename silently invalidate all of them, so it stays a literal on purpose -
 * the same reason lib/trust-gate/sign.ts pins its EIP-712 domain.
 */
const PROVIDER_SUBMISSION_SIGNING_PREFIX = "Veyra Provider Submission";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ executionId: string }> }
) {
  const { executionId } = await params;
  const body = await req.json();
  const { contentUri, contentHash, contentType, providerWallet, signature, nonce, issuedAt } = body;

  // 1. Validate required fields
  if (!contentUri || !contentHash || !providerWallet || !signature)
    return NextResponse.json({ error: "MISSING_REQUIRED_FIELDS" }, { status: 400 });

  // 2. Fetch execution
  const attempt = await getExecutionAttempt(executionId);
  if (!attempt) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  // 3. Verify state
  if (attempt.state !== "WAITING_FOR_PROVIDER")
    return NextResponse.json({ error: "INVALID_STATE" }, { status: 409 });

  // 4. Verify provider matches job provider
  const jobProvider = attempt.counterpartyWallet;
  if (providerWallet.toLowerCase() !== jobProvider?.toLowerCase())
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 }); // 404 to prevent enumeration

  // 5. Verify wallet signature
  // Note: attempt.jobId is cast to any as it's not strictly in the type, or we use externalReference
  const message = `${PROVIDER_SUBMISSION_SIGNING_PREFIX}:${executionId}:${(attempt as any).jobId || (attempt as any).externalReference || ""}:${contentHash}:${issuedAt}:${nonce}`;
  const valid = await verifyMessage({ address: providerWallet as `0x${string}`, message, signature });
  if (!valid) return NextResponse.json({ error: "INVALID_SIGNATURE" }, { status: 401 });

  // 6. Update execution with provider submission
  await updateExecutionAttemptState(executionId, "EVALUATING", {
    providerContentUri: contentUri,
    providerContentHash: contentHash,
    providerContentType: contentType,
    providerSubmittedAt: new Date().toISOString(),
  });

  return NextResponse.json({ status: "ACCEPTED", executionId });
}
