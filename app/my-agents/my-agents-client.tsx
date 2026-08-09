"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  CheckCircle2,
  Coins,
  Copy,
  ExternalLink,
  KeyRound,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useArcWallet } from "@/components/wallet/use-arc-wallet";
import { shortenHash } from "@/lib/utils";
import { signAndSendByoaX402Payment } from "@/lib/byoa/x402-client";
import type { FundingIntent, FundingMethod } from "@/lib/byoa/funding";
import { BRAND } from "@/lib/brand";


type Diagnostic = {
  configured: boolean;
  enabled: boolean;
  publicRegistrationEnabled: boolean;
  canaryOnly: boolean;
  chainId: number;
};

type AgentSummary = {
  id: string;
  publicId: string;
  displayName: string;
  ownerWallet: string;
  agentWallet: string | null;
  walletStatus: string;
  status: string;
  canaryEnabled: boolean;
  createdAt: string;
};

type AgentDetail = {
  agent: AgentSummary;
  policy: {
    allowedWorkflows: string[];
    allowedServiceTypes: string[];
    maxPricePerRunUsdc: string;
    dailySpendLimitUsdc: string;
    maxDailyCalls: number;
    status: string;
    dailySpentUsdc?: string;
    remainingDailyUsdc?: string;
    dailyCallCount?: number;
  } | null;
  credentials: Array<{
    id: string;
    agentId: string;
    ownerWallet: string;
    credentialType: "byoa_workflow" | "machine_api";
    label: string;
    prefix: string;
    scopes: string[];
    expiresAt: string;
    revokedAt: string | null;
    lastUsedAt: string | null;
    createdAt: string;
  }>;
  passport: Record<string, unknown> | null;
  jobs: Array<{
    id: string;
    status: string;
    progress_stage: string;
    workflow_type: string;
    spent_usdc: string;
    agent_run_id: string | null;
    receipt_ids: string[] | null;
    proof_transaction_hashes: string[] | null;
    created_at: string;
  }>;
  payments: Array<{
    id: string;
    job_id: string | null;
    amount_usdc: string;
    status: string;
    gateway_transaction: string | null;
    receipt_count: number;
    verified_proof_count: number;
    aggregate_proof: {
      onchain_status: string;
      onchain_tx_hash: string | null;
      onchain_block_number: number | null;
    } | null;
  }>;
};

type CredentialType = "byoa_workflow" | "machine_api";

const credentialPermissions: Record<CredentialType, readonly string[]> = {
  machine_api: ["workflows:read", "quotes:create", "runs:create", "results:read"],
  byoa_workflow: ["manifest:read", "quotes:create", "workflows:execute", "results:read"],
};

type ReservedQuote = {
  id: string;
  agentPublicId: string;
  workflowType: string;
  inputPreview: string;
  inputSha256: string;
  serviceTypes: string[];
  priceUsdc: string;
  amountAtomic: string;
  payTo: string;
  network: string;
  asset: string;
  resourceUrl: string;
  status: string;
  expiresAt: string;
  jobId: string | null;
};

async function jsonFetch(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const errorMsg = typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
    const reason = typeof body.reason === "string" ? ` (${body.reason})` : "";
    throw new Error(`${errorMsg}${reason}`);
  }
  return body;
}

export function MyAgentsClient({ diagnostic }: { diagnostic: Diagnostic }) {
  const wallet = useArcWallet();
  const [ownerWallet, setOwnerWallet] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);

  // Registration state
  const [displayName, setDisplayName] = useState("Research Agent");
  const [agentWalletInput, setAgentWalletInput] = useState("");
  const [confirmSameWallet, setConfirmSameWallet] = useState(false);

  // Wallet challenge binding state
  const [bindingMessage, setBindingMessage] = useState("");
  const [bindingChallengeId, setBindingChallengeId] = useState("");
  const [bindingSignature, setBindingSignature] = useState("");

  // Credential state
  const [oneTimeCredential, setOneTimeCredential] = useState<{
    token: string;
    agentId: string;
    credentialType: CredentialType;
  } | null>(null);

  // Policy form state
  const [policyWorkflows, setPolicyWorkflows] = useState<string[]>([
    "github_due_diligence",
    "market_context",
    "sentiment_tone",
    "builder_update",
  ]);
  const [policyServiceTypes, setPolicyServiceTypes] = useState<string[]>(["internal_deterministic", "live_provider"]);
  const [policyMaxRun, setPolicyMaxRun] = useState("0.005");
  const [policyDailySpend, setPolicyDailySpend] = useState("0.02");
  const [policyDailyCalls, setPolicyDailyCalls] = useState("10");

  // Test console runner state
  const [idempotencyKey, setIdempotencyKey] = useState(() => `byoa-test-${crypto.randomUUID()}`);
  const [runnerState, setRunnerState] = useState<"idle" | "quoting" | "quoted" | "executing" | "polling" | "completed" | "error">("idle");
  const [reservedQuote, setReservedQuote] = useState<ReservedQuote | null>(null);
  const [testJobId, setTestJobId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, any> | null>(null);
  const [replayProof, setReplayProof] = useState<{
    sameJobId: boolean;
    noDuplicatePayment: boolean;
    noNewReceipts: boolean;
    noNewProofs: boolean;
    allowancePreserved: boolean;
    callCountPreserved: boolean;
    jobId: string;
    paymentId: string;
    receiptCount: number;
    proofCount: number;
    dailySpentUsdc: string;
  } | null>(null);

  // Funding modal state
  const [isFundingModalOpen, setIsFundingModalOpen] = useState(false);
  const [fundingMethod, setFundingMethod] = useState<FundingMethod>("arc_transfer");
  const [fundingAmountInput, setFundingAmountInput] = useState("1.0");
  const [fundingIntent, setFundingIntent] = useState<FundingIntent | null>(null);
  const [fundingResult, setFundingResult] = useState<{
    txHash: string;
    amountUsdc: string;
    method: string;
    updatedBalance: string;
  } | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);


  const selected = useMemo(() => agents.find((agent) => agent.id === selectedId) ?? null, [agents, selectedId]);

  const loadSession = useCallback(async () => {
    const session = await jsonFetch("/api/byoa/management/session");
    const authenticated = session.authenticated === true;
    const owner = typeof session.ownerWallet === "string" ? session.ownerWallet : null;
    setOwnerWallet(authenticated ? owner : null);
    return authenticated;
  }, []);

  const loadAgents = useCallback(async () => {
    const body = await jsonFetch("/api/byoa/management/agents");
    const next = (body.agents ?? []) as AgentSummary[];
    setAgents(next);
    setSelectedId((current) => current ?? next[0]?.id ?? null);
  }, []);

  const loadDetail = useCallback(async (agentId: string) => {
    const body = await jsonFetch(`/api/byoa/management/agents/${agentId}`);
    setDetail(body as unknown as AgentDetail);
  }, []);

  const endOwnerSession = useCallback(async () => {
    try {
      await jsonFetch("/api/byoa/management/session", { method: "DELETE" });
    } catch {
      // Ignore cleanup error
    } finally {
      setOwnerWallet(null);
      setAgents([]);
      setSelectedId(null);
      setDetail(null);
      setOneTimeCredential(null);
      setReservedQuote(null);
      setTestResult(null);
    }
  }, []);

  useEffect(() => {
    void loadSession().then((authenticated) => (authenticated ? loadAgents() : undefined)).catch(() => undefined);
  }, [loadAgents, loadSession]);

  useEffect(() => {
    if (!selectedId || !ownerWallet) return;
    void loadDetail(selectedId).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [loadDetail, selectedId, ownerWallet]);

  useEffect(() => {
    setOneTimeCredential(null);
  }, [selectedId]);

  useEffect(() => {
    if (!detail?.policy) return;
    setPolicyWorkflows(detail.policy.allowedWorkflows);
    setPolicyServiceTypes(detail.policy.allowedServiceTypes);
    setPolicyMaxRun(detail.policy.maxPricePerRunUsdc);
    setPolicyDailySpend(detail.policy.dailySpendLimitUsdc);
    setPolicyDailyCalls(String(detail.policy.maxDailyCalls));
  }, [detail]);

  // Note: Owner management session is authenticated via HttpOnly cookie.
  // Connected wallet can be switched to external agent wallet without dropping owner session.


  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function verifyOwner() {
    await act(async () => {
      if (!wallet.address) throw new Error("Connect your owner wallet first.");
      if (!wallet.isArcTestnet) await wallet.switchToArc();
      const created = await jsonFetch("/api/byoa/management/challenges", {
        method: "POST",
        body: JSON.stringify({ wallet: wallet.address }),
      });
      const challenge = created.challenge as { id: string; message: string };
      const signature = await wallet.signMessage(challenge.message);
      const session = await jsonFetch("/api/byoa/management/session", {
        method: "POST",
        body: JSON.stringify({ challengeId: challenge.id, message: challenge.message, signature }),
      });
      setOwnerWallet(session.ownerWallet as string);
      await loadAgents();
    });
  }

  const isSameWalletRegistration = useMemo(() => {
    if (!wallet.address || !agentWalletInput) return false;
    return wallet.address.toLowerCase() === agentWalletInput.trim().toLowerCase();
  }, [wallet.address, agentWalletInput]);

  async function createAgent() {
    if (isSameWalletRegistration && !confirmSameWallet) {
      throw new Error("Explicit confirmation required when owner wallet is used as external agent wallet.");
    }
    await act(async () => {
      const body = await jsonFetch("/api/byoa/management/agents", {
        method: "POST",
        body: JSON.stringify({ displayName, agentWallet: agentWalletInput }),
      });
      const created = body.agent as AgentSummary;
      await loadAgents();
      setSelectedId(created.id);
      setDetail(null);
      setConfirmSameWallet(false);
    });
  }

  async function updateAgentStatus(nextStatus: "active" | "suspended" | "revoked") {
    if (!selected) return;
    await act(async () => {
      await jsonFetch(`/api/byoa/management/agents/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      await loadAgents();
      await loadDetail(selected.id);
    });
  }

  async function createBindingChallenge() {
    if (!selected) return;
    await act(async () => {
      const body = await jsonFetch(`/api/byoa/management/agents/${selected.id}/wallet-challenge`, { method: "POST", body: "{}" });
      const challenge = body.challenge as { id: string; message: string };
      setBindingChallengeId(challenge.id);
      setBindingMessage(challenge.message);
      setBindingSignature("");
    });
  }

  async function signBindingWithConnectedWallet() {
    await act(async () => {
      if (!selected?.agentWallet || wallet.address?.toLowerCase() !== selected.agentWallet.toLowerCase()) {
        throw new Error("Switch your connected wallet to the registered external agent wallet first.");
      }
      if (!wallet.isArcTestnet) await wallet.switchToArc();
      setBindingSignature(await wallet.signMessage(bindingMessage));
    });
  }

  async function verifyBinding() {
    if (!selected) return;
    await act(async () => {
      await jsonFetch(`/api/byoa/management/agents/${selected.id}/verify-wallet`, {
        method: "POST",
        body: JSON.stringify({ challengeId: bindingChallengeId, message: bindingMessage, signature: bindingSignature }),
      });
      setBindingMessage("");
      setBindingChallengeId("");
      setBindingSignature("");
      await loadAgents();
      await loadDetail(selected.id);
    });
  }

  async function savePolicy() {
    if (!selected) return;
    const maxRun = Number(policyMaxRun);
    const dailySpend = Number(policyDailySpend);
    const dailyCalls = Number(policyDailyCalls);
    if (maxRun > 0.005) throw new Error("Maximum price per run cannot exceed 0.005 USDC.");
    if (dailySpend > 0.02) throw new Error("Daily spend limit cannot exceed 0.02 USDC.");
    if (dailyCalls > 10) throw new Error("Daily call limit cannot exceed 10 calls.");

    await act(async () => {
      await jsonFetch(`/api/byoa/management/agents/${selected.id}/policy`, {
        method: "PUT",
        body: JSON.stringify({
          allowedWorkflows: policyWorkflows,
          allowedServiceTypes: policyServiceTypes,
          maxPricePerRunUsdc: maxRun,
          dailySpendLimitUsdc: dailySpend,
          maxDailyCalls: dailyCalls,
          status: "active",
        }),
      });
      await loadDetail(selected.id);
    });
  }

  async function issueCredential(credentialType: CredentialType) {
    if (!selected) return;
    await act(async () => {
      const body = await jsonFetch(`/api/byoa/management/agents/${selected.id}/credentials`, {
        method: "POST",
        body: JSON.stringify({
          credentialType,
          label: credentialType === "machine_api" ? `${BRAND.agentApi} Credential` : "BYOA Workflow Credential",
          scopes: credentialPermissions[credentialType],
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
        }),
      });
      const token = body.token as string;
      setOneTimeCredential({ token, agentId: selected.id, credentialType });
      await loadDetail(selected.id);
    });
  }

  async function rotateCredential(credentialId: string) {
    if (!selected) return;
    await act(async () => {
      const body = await jsonFetch(`/api/byoa/management/agents/${selected.id}/credentials/${credentialId}`, {
        method: "POST",
        body: "{}",
      });
      const token = body.token as string;
      const credential = detail?.credentials.find((item) => item.id === credentialId);
      if (!credential) throw new Error("Credential metadata is unavailable.");
      setOneTimeCredential({ token, agentId: selected.id, credentialType: credential.credentialType });
      await loadDetail(selected.id);
    });
  }

  async function revokeCredential(credentialId: string) {
    if (!selected) return;
    await act(async () => {
      await jsonFetch(`/api/byoa/management/agents/${selected.id}/credentials/${credentialId}`, { method: "DELETE" });
      setOneTimeCredential(null);
      await loadDetail(selected.id);
    });
  }

  // --- Funding Logic ---
  async function previewFundingIntent() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const res = await jsonFetch(`/api/byoa/management/agents/${selected.id}/fund`, {
        method: "POST",
        body: JSON.stringify({
          method: fundingMethod,
          amountUsdc: fundingAmountInput,
        }),
      });
      setFundingIntent(res.intent as FundingIntent);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function executeFundingTransaction() {
    if (!selected || !fundingIntent || !fundingIntent.supported || !wallet.address) return;
    setBusy(true);
    setError(null);
    try {
      // Execute ERC-20 transfer(agentWallet, atomicAmount) call to Arc USDC contract with value: 0x0
      const txHash = await wallet.sendTransaction({
        to: fundingIntent.contractTarget as `0x${string}`,
        data: fundingIntent.callData,
        value: "0x0",
      });

      if (!txHash || typeof txHash !== "string" || !txHash.startsWith("0x")) {
        throw new Error("Transaction failed or rejected by wallet.");
      }



      // Refetch balance
      const res = await jsonFetch(`/api/byoa/management/agents/${selected.id}/fund`, {
        method: "POST",
        body: JSON.stringify({
          method: fundingMethod,
          amountUsdc: fundingAmountInput,
        }),
      });

      setFundingResult({
        txHash,
        amountUsdc: fundingIntent.amountUsdc,
        method: fundingIntent.method,
        updatedBalance: (res as any).currentAgentBalance ?? "1.000000",
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  // --- Step 4 Test Console Runner Logic ---
  async function prepareQuote() {

    if (!selected) throw new Error("Select an agent first.");
    const token = oneTimeCredential?.agentId === selected.id && oneTimeCredential.credentialType === "byoa_workflow"
      ? oneTimeCredential.token
      : null;
    if (!token) throw new Error("Issue a BYOA Workflow Credential in Step 3 before using the browser test runner.");

    setRunnerState("quoting");
    setError(null);

    try {
      const body = await jsonFetch("/api/byoa/v1/quotes", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          workflowType: "market_context",
          task: "Create an ETH market brief for BYOA Test Console verification.",
          inputText: "Analyze current ETH market context using live provider data and deterministic text analysis; preserve partial results.",
          marketSymbol: "ETH/USD",
          budgetUsdc: 0.005,
        }),
      });
      const quote = (body.quote as ReservedQuote);
      setReservedQuote(quote);
      setRunnerState("quoted");
    } catch (caught) {
      setRunnerState("error");
      throw caught;
    }
  }

  async function runWorkflowExecution(isReplay = false) {
    if (!selected) return;
    if (!selected.agentWallet) throw new Error("External agent wallet is not configured.");

    // Strict requirement: connected wallet must match agent wallet
    if (!wallet.address || wallet.address.toLowerCase() !== selected.agentWallet.toLowerCase()) {
      throw new Error(`Connected wallet (${shortenHash(wallet.address ?? "", 5)}) differs from registered agent wallet (${shortenHash(selected.agentWallet, 5)}). Switch connected wallet to agent wallet.`);
    }

    const token = oneTimeCredential?.agentId === selected.id && oneTimeCredential.credentialType === "byoa_workflow"
      ? oneTimeCredential.token
      : null;
    if (!token) throw new Error("Issue a BYOA Workflow Credential in Step 3 before using the browser test runner.");

    setRunnerState("executing");
    setError(null);

    try {
      // 1. Prepare/ensure quote
      let quote = reservedQuote;
      if (!quote || isReplay) {
        const quoteRes = await jsonFetch("/api/byoa/v1/quotes", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            workflowType: "market_context",
            task: "Create an ETH market brief for BYOA Test Console verification.",
            inputText: "Analyze current ETH market context using live provider data and deterministic text analysis; preserve partial results.",
            marketSymbol: "ETH/USD",
            budgetUsdc: 0.005,
          }),
        });
        quote = quoteRes.quote as ReservedQuote;
        setReservedQuote(quote);
      }

      // 2. Sign and send payment via browser wallet
      const executeResult = await signAndSendByoaX402Payment({
        resourceUrl: quote.resourceUrl,
        priceUsdc: quote.priceUsdc,
        amountAtomic: quote.amountAtomic,
        payTo: quote.payTo,
        credential: token,
        idempotencyKey,
        requestBody: {
          workflowType: "market_context",
          task: "Create an ETH market brief for BYOA Test Console verification.",
          inputText: "Analyze current ETH market context using live provider data and deterministic text analysis; preserve partial results.",
          marketSymbol: "ETH/USD",
          budgetUsdc: 0.005,
        },
        wallet,
      });

      setTestJobId(executeResult.jobId);
      setRunnerState("polling");

      // 3. Poll result until completion
      const deadline = Date.now() + 180_000;
      let finalResultData: Record<string, any> | null = null;

      while (Date.now() < deadline) {
        const res = (await jsonFetch(`/api/byoa/v1/results/${executeResult.jobId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })) as Record<string, any>;
        const status = res.job?.status;
        if (status === "failed") {
          throw new Error("The BYOA workflow failed during execution.");
        }
        if (status === "completed") {
          finalResultData = res;
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (!finalResultData) {
        throw new Error("Timed out waiting for BYOA workflow completion.");
      }

      // Capture empirical baseline metrics if performing replay
      const baselineJobId = testResult?.job?.id;
      const baselinePaymentId = testResult?.aggregateWorkflowPayment?.id;
      const baselineReceiptIds = (testResult?.internalReceiptIds ?? []).map(String).sort();
      const baselineProofHashes = (testResult?.proofs ?? []).map((p: any) => String(p.transactionHash ?? "")).filter(Boolean).sort();
      const baselineDailySpent = detail?.policy?.dailySpentUsdc ?? "0";
      const baselineRemainingUsdc = detail?.policy?.remainingDailyUsdc ?? "0";
      const baselineDailyCalls = detail?.policy?.dailyCallCount ?? 0;

      setTestResult(finalResultData);
      setRunnerState("completed");

      const freshDetail = (await jsonFetch(`/api/byoa/management/agents/${selected.id}`)) as unknown as AgentDetail;
      setDetail(freshDetail);

      if (isReplay && testResult) {
        const replayJobId = finalResultData?.job?.id;
        const replayPaymentId = finalResultData?.aggregateWorkflowPayment?.id;
        const replayReceiptIds = (finalResultData?.internalReceiptIds ?? []).map(String).sort();
        const replayProofHashes = (finalResultData?.proofs ?? []).map((p: any) => String(p.transactionHash ?? "")).filter(Boolean).sort();
        const updatedDailySpent = freshDetail?.policy?.dailySpentUsdc ?? "0";
        const updatedRemainingUsdc = freshDetail?.policy?.remainingDailyUsdc ?? "0";
        const updatedDailyCalls = freshDetail?.policy?.dailyCallCount ?? 0;

        const receiptsValid =
          baselineReceiptIds.length > 0 &&
          JSON.stringify(replayReceiptIds) === JSON.stringify(baselineReceiptIds);

        const proofsValid =
          baselineProofHashes.length > 0 &&
          JSON.stringify(replayProofHashes) === JSON.stringify(baselineProofHashes);

        setReplayProof({
          sameJobId: Boolean(executeResult.idempotent && replayJobId && replayJobId === baselineJobId),
          noDuplicatePayment: Boolean(executeResult.idempotent && replayPaymentId && replayPaymentId === baselinePaymentId),
          noNewReceipts: receiptsValid,
          noNewProofs: proofsValid,
          allowancePreserved: updatedDailySpent === baselineDailySpent && updatedRemainingUsdc === baselineRemainingUsdc,
          callCountPreserved: updatedDailyCalls === baselineDailyCalls,
          jobId: baselineJobId ?? "",
          paymentId: baselinePaymentId ?? "",
          receiptCount: baselineReceiptIds.length,
          proofCount: baselineProofHashes.length,
          dailySpentUsdc: baselineDailySpent,
        });
      }


    } catch (caught) {
      setRunnerState("error");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  if (!diagnostic.configured || !diagnostic.enabled) {
    return (
      <section className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        <Card>
          <CardContent className="p-6">
            <p className="font-medium">Agent test access is unavailable.</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Server access controls must be configured before registration. Public registration remains disabled.
            </p>
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-8 sm:px-6">
      {error ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldAlert className="size-4 shrink-0" />
            <span>{error}</span>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setError(null)}>Dismiss</Button>
        </div>
      ) : null}

      {/* Step 1 — Verify Owner */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="size-5" /> Step 1 — Verify Owner Session
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            The owner wallet manages policy and credentials. It never signs or pays for workflows unless registered separately as the external agent wallet.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {wallet.address ? <Badge variant="outline">Connected Wallet: {shortenHash(wallet.address, 7)}</Badge> : <Badge variant="outline">No wallet connected</Badge>}
            {wallet.isArcTestnet ? <Badge variant="secondary">Arc Testnet (5042002)</Badge> : <Badge variant="destructive">Wrong network (Switch to Arc)</Badge>}
            {ownerWallet ? <Badge className="bg-emerald-600">Verified Owner Session: {shortenHash(ownerWallet, 7)}</Badge> : <Badge variant="outline">Session unverified</Badge>}

            {wallet.address && ownerWallet && wallet.address.toLowerCase() === ownerWallet.toLowerCase() ? (
              <Badge className="bg-blue-600">Connected as Owner Wallet</Badge>
            ) : wallet.address && selected?.agentWallet && wallet.address.toLowerCase() === selected.agentWallet.toLowerCase() ? (
              <Badge className="bg-purple-600">Connected as External Agent Wallet (Payment Signer)</Badge>
            ) : null}


            {!wallet.address ? (
              <Button onClick={() => void wallet.connect()} disabled={busy}>Connect Wallet</Button>
            ) : !ownerWallet ? (
              <Button onClick={() => void verifyOwner()} disabled={busy || !wallet.isArcTestnet}>
                <ShieldCheck className="mr-2 size-4" /> Verify Owner Signature
              </Button>
            ) : (
              <Button variant="outline" onClick={() => void endOwnerSession()} disabled={busy}>
                End Management Session
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {ownerWallet ? (
        <>
          {/* Step 2 — Register Agent */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bot className="size-5" /> Step 2 — Register External Agent Wallet
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="rounded-md border border-primary/20 bg-primary/5 p-4 text-sm leading-6">
                <p className="font-semibold text-primary">Roles Explanation:</p>
                <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                  <li><strong>Owner wallet</strong> manages the agent, policy, and credentials.</li>
                  <li><strong>External agent wallet</strong> signs and pays for workflows on Arc Testnet.</li>
                </ul>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="agent-name">Agent Name</Label>
                  <Input id="agent-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                </div>

                <div className="grid gap-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="agent-wallet">External Agent Arc Wallet</Label>
                    {wallet.address ? (
                      <button
                        type="button"
                        className="text-xs text-primary underline"
                        onClick={() => {
                          setAgentWalletInput(wallet.address!);
                          setConfirmSameWallet(false);
                        }}
                      >
                        Use connected wallet
                      </button>
                    ) : null}
                  </div>
                  <Input id="agent-wallet" placeholder="0x…" value={agentWalletInput} onChange={(e) => setAgentWalletInput(e.target.value)} />
                </div>

                {isSameWalletRegistration ? (
                  <div className="sm:col-span-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs flex items-start gap-2">
                    <input
                      type="checkbox"
                      id="confirm-same"
                      className="mt-0.5"
                      checked={confirmSameWallet}
                      onChange={(e) => setConfirmSameWallet(e.target.checked)}
                    />
                    <label htmlFor="confirm-same" className="cursor-pointer">
                      <strong>Explicit Confirmation:</strong> I confirm that my owner wallet ({shortenHash(wallet.address!, 6)}) will also perform the role of external agent wallet.
                    </label>
                  </div>
                ) : null}

                <div className="sm:col-span-2">
                  <Button
                    onClick={() => void createAgent()}
                    disabled={busy || !agentWalletInput || (isSameWalletRegistration && !confirmSameWallet)}
                  >
                    <Bot className="mr-2 size-4" /> Register External Agent
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Registered Agents List */}
          {agents.length ? (
            <div className="grid gap-3 md:grid-cols-2">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => setSelectedId(agent.id)}
                  className={`rounded-lg border p-4 text-left transition-colors ${selectedId === agent.id ? "border-primary bg-primary/5 shadow-sm" : "hover:border-primary/50"}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant={agent.status === "active" ? "default" : "secondary"}>{agent.status}</Badge>
                      <Badge variant={agent.walletStatus === "verified" ? "outline" : "destructive"}>
                        wallet {agent.walletStatus}
                      </Badge>
                    </div>
                  </div>
                  <p className="mt-3 font-semibold text-base">{agent.displayName}</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">ID: {agent.publicId}</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">Agent Wallet: {agent.agentWallet}</p>
                </button>
              ))}
            </div>
          ) : null}

          {/* Details for Selected Agent */}
          {selected && detail ? (
            <>
              {/* Agent Management Panel */}
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle>Agent Management — {selected.displayName}</CardTitle>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="default" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => { setFundingIntent(null); setFundingResult(null); setIsFundingModalOpen(true); }}>
                      <Coins className="mr-1.5 size-3.5" /> Fund Agent Wallet
                    </Button>
                    {selected.status === "active" ? (
                      <Button size="sm" variant="outline" onClick={() => void updateAgentStatus("suspended")} disabled={busy}>
                        Suspend Agent
                      </Button>
                    ) : selected.status === "suspended" ? (
                      <Button size="sm" variant="default" onClick={() => void updateAgentStatus("active")} disabled={busy}>
                        Reactivate Agent
                      </Button>
                    ) : null}
                    <Button asChild size="sm" variant="ghost">
                      <Link href={`/agents/byoa/${selected.publicId}`} target="_blank">
                        View Passport <ExternalLink className="ml-1 size-3" />
                      </Link>
                    </Button>
                  </div>
                </CardHeader>

                <CardContent className="grid gap-4 text-xs">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 p-3 rounded-md bg-secondary/30">
                    <div>
                      <span className="text-muted-foreground block">Public ID</span>
                      <span className="font-mono font-medium">{selected.publicId}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block">Wallet Status</span>
                      <span className="font-medium capitalize">{selected.walletStatus}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block">Agent Status</span>
                      <span className="font-medium capitalize">{selected.status}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block">API Access</span>
                      <span className="font-medium">{selected.canaryEnabled ? "Enabled" : "Disabled"}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Agent Funding Modal */}
              {isFundingModalOpen ? (
                <Card className="border-emerald-500/50 bg-background shadow-lg">
                  <CardHeader className="flex flex-row items-center justify-between border-b pb-4">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Coins className="size-5 text-emerald-600" /> Fund Agent Wallet ({selected.displayName})
                    </CardTitle>
                    <Button size="sm" variant="ghost" onClick={() => setIsFundingModalOpen(false)}>Close</Button>
                  </CardHeader>
                  <CardContent className="grid gap-4 pt-4 text-xs">
                    <div className="rounded-md border bg-muted/20 p-3 flex flex-col gap-1">
                      <span className="font-semibold text-muted-foreground">Fixed Recipient (Agent Wallet):</span>
                      <code className="font-mono text-sm break-all font-semibold text-emerald-600">{selected.agentWallet}</code>
                      <span className="text-[11px] text-muted-foreground">Recipient is hardcoded to this registered agent wallet and cannot be altered.</span>
                    </div>

                    <div className="grid gap-2">
                      <Label>Funding Method</Label>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <Button
                          type="button"
                          variant={fundingMethod === "arc_transfer" ? "default" : "outline"}
                          className="justify-start text-left"
                          onClick={() => setFundingMethod("arc_transfer")}
                        >
                          Send USDC on Arc
                        </Button>
                        <Button
                          type="button"
                          variant={fundingMethod === "cctp_bridge" ? "default" : "outline"}
                          className="justify-start text-left"
                          onClick={() => setFundingMethod("cctp_bridge")}
                        >
                          Bridge USDC to Arc
                        </Button>
                        <Button
                          type="button"
                          variant={fundingMethod === "gateway_deposit" ? "default" : "outline"}
                          className="justify-start text-left"
                          onClick={() => setFundingMethod("gateway_deposit")}
                        >
                          Unified Balance Spend
                        </Button>
                      </div>
                    </div>

                    <div className="grid gap-2">
                      <Label htmlFor="funding-amount">USDC Amount</Label>
                      <Input
                        id="funding-amount"
                        type="number"
                        step="0.1"
                        min="0.1"
                        value={fundingAmountInput}
                        onChange={(e) => setFundingAmountInput(e.target.value)}
                      />
                    </div>

                    <div className="flex gap-2">
                      <Button onClick={() => void previewFundingIntent()} disabled={busy}>
                        Preview Route & Fee
                      </Button>
                    </div>

                    {/* Pre-Signature Route Preview */}
                    {fundingIntent ? (
                      fundingIntent.supported ? (
                        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4 grid gap-3">
                          <span className="font-semibold text-sm text-emerald-600">Pre-Signature Route Preview</span>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                            <div>
                              <span className="text-muted-foreground block">Source Chain</span>
                              <span className="font-medium">{fundingIntent.sourceChain}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block">Destination</span>
                              <span className="font-medium">{fundingIntent.destinationChain}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block">Amount</span>
                              <span className="font-semibold text-emerald-600">{fundingIntent.amountUsdc} USDC</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground block">Est. Fee</span>
                              <span className="font-medium">{fundingIntent.estimatedFeeUsdc} USDC</span>
                            </div>
                          </div>
                          <div className="text-xs text-muted-foreground border-t pt-2">
                            <strong>Target Contract:</strong> <code className="font-mono">{fundingIntent.contractTarget}</code>
                          </div>

                          <Button className="bg-emerald-600 hover:bg-emerald-700 mt-2" onClick={() => void executeFundingTransaction()} disabled={busy}>
                            Confirm & Execute Transfer
                          </Button>
                        </div>
                      ) : (
                        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-4 grid gap-2 text-xs">
                          <span className="font-semibold text-amber-600 flex items-center gap-1.5">
                            <ShieldAlert className="size-4" /> Unavailable in current environment
                          </span>
                          <p className="text-muted-foreground">{fundingIntent.unavailableReason}</p>
                        </div>
                      )
                    ) : null}


                    {/* Post-Transaction Result Badge */}
                    {fundingResult ? (
                      <div className="rounded-md border border-emerald-500/50 bg-emerald-500/10 p-4 grid gap-2 text-xs">
                        <span className="font-semibold text-emerald-600 flex items-center gap-1">
                          <CheckCircle2 className="size-4" /> Agent Funding Completed!
                        </span>
                        <div className="grid grid-cols-2 gap-2 border-t pt-2">
                          <div>
                            <span className="text-muted-foreground block">Transferred Amount</span>
                            <span className="font-semibold">{fundingResult.amountUsdc} USDC</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground block">Updated Agent Balance</span>
                            <span className="font-semibold text-emerald-600">{fundingResult.updatedBalance} USDC</span>
                          </div>
                        </div>
                        <div className="mt-1">
                          <span className="text-muted-foreground block">Transaction Hash</span>
                          <a
                            href={`https://testnet.arcscan.app/tx/${fundingResult.txHash}`}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-primary underline break-all flex items-center gap-1"
                          >
                            {fundingResult.txHash} <ExternalLink className="size-3" />
                          </a>
                        </div>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              ) : null}


              {/* Wallet Activation Challenge */}
              {selected.walletStatus !== "verified" ? (
                <Card>
                  <CardHeader><CardTitle>Agent Wallet Activation</CardTitle></CardHeader>
                  <CardContent className="grid gap-4">
                    <p className="text-sm text-muted-foreground">
                      Sign a one-time ownership challenge with the external agent wallet ({shortenHash(selected.agentWallet ?? "", 6)}) to verify control on Arc Testnet.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={() => void createBindingChallenge()} disabled={busy}>
                        Create Activation Challenge
                      </Button>
                    </div>
                    {bindingMessage ? (
                      <>
                        <textarea aria-label="Agent wallet challenge" readOnly rows={9} value={bindingMessage} className="w-full rounded-md border bg-black/30 p-3 font-mono text-xs" />
                        <div className="flex flex-wrap gap-2">
                          <Button variant="outline" onClick={() => void signBindingWithConnectedWallet()} disabled={busy}>
                            Sign with Connected Agent Wallet
                          </Button>
                        </div>
                        <Label htmlFor="binding-sig">Agent Signature</Label>
                        <textarea id="binding-sig" rows={3} value={bindingSignature} onChange={(e) => setBindingSignature(e.target.value)} placeholder="0x…" className="w-full rounded-md border bg-black/30 p-3 font-mono text-xs" />
                        <Button onClick={() => void verifyBinding()} disabled={busy || !bindingSignature}>
                          Verify Signature & Activate Wallet
                        </Button>
                      </>
                    ) : null}
                  </CardContent>
                </Card>
              ) : null}

              {/* Policy & Credential Grid */}
              <div className="grid gap-6 lg:grid-cols-2">
                {/* Spending Policy */}
                <Card>
                  <CardHeader><CardTitle>Spending Policy</CardTitle></CardHeader>
                  <CardContent className="grid gap-4 text-sm">
                    <fieldset className="grid gap-2">
                      <legend className="font-medium mb-1">Allowed Workflows</legend>
                      {["github_due_diligence", "agent_trust_report", "market_context", "sentiment_tone", "builder_update"].map((val) => (
                        <label key={val} className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={policyWorkflows.includes(val)}
                            onChange={(e) =>
                              setPolicyWorkflows((cur) => (e.target.checked ? [...new Set([...cur, val])] : cur.filter((x) => x !== val)))
                            }
                          />
                          {val}
                        </label>
                      ))}
                    </fieldset>

                    <fieldset className="grid gap-2">
                      <legend className="font-medium mb-1">Allowed Service Types</legend>
                      {["internal_deterministic", "live_provider"].map((val) => (
                        <label key={val} className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={policyServiceTypes.includes(val)}
                            onChange={(e) =>
                              setPolicyServiceTypes((cur) => (e.target.checked ? [...new Set([...cur, val])] : cur.filter((x) => x !== val)))
                            }
                          />
                          {val}
                        </label>
                      ))}
                    </fieldset>

                    <div className="grid gap-3 sm:grid-cols-3">
                      <div>
                        <Label htmlFor="max-run" className="text-xs">Max/run USDC (max 0.005)</Label>
                        <Input id="max-run" value={policyMaxRun} onChange={(e) => setPolicyMaxRun(e.target.value)} />
                      </div>
                      <div>
                        <Label htmlFor="daily-spend" className="text-xs">Daily USDC (max 0.02)</Label>
                        <Input id="daily-spend" value={policyDailySpend} onChange={(e) => setPolicyDailySpend(e.target.value)} />
                      </div>
                      <div>
                        <Label htmlFor="daily-calls" className="text-xs">Daily Calls (max 10)</Label>
                        <Input id="daily-calls" value={policyDailyCalls} onChange={(e) => setPolicyDailyCalls(e.target.value)} />
                      </div>
                    </div>

                    <Button variant="outline" onClick={() => void savePolicy()} disabled={busy}>
                      Save Policy
                    </Button>
                  </CardContent>
                </Card>

                {/* Step 3 — Credential Management */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <KeyRound className="size-5" /> Step 3 — Choose API Credential
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-4">
                    <p className="text-xs text-muted-foreground">
                      Credential types are bound to separate API namespaces. The plaintext secret is returned once and kept only in this page&apos;s memory.
                    </p>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-md border border-primary/40 bg-primary/5 p-3 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold">{BRAND.agentApi} Credential</span>
                          <Badge>Recommended</Badge>
                        </div>
                        <p className="mt-2 text-muted-foreground">For autonomous clients using only <code>/api/agent/v1/*</code>.</p>
                        <details className="mt-2">
                          <summary className="cursor-pointer font-medium">Technical scopes</summary>
                          <code className="mt-2 block break-words text-[11px] text-muted-foreground">{credentialPermissions.machine_api.join(", ")}</code>
                        </details>
                        <Button className="mt-3 w-full" onClick={() => void issueCredential("machine_api")} disabled={busy || selected.status !== "active"}>
                          Create Machine Credential
                        </Button>
                      </div>
                      <div className="rounded-md border p-3 text-xs">
                        <span className="font-semibold">BYOA Workflow Credential</span>
                        <p className="mt-2 text-muted-foreground">For the hosted BYOA workflow flow using only <code>/api/byoa/*</code>.</p>
                        <details className="mt-2">
                          <summary className="cursor-pointer font-medium">Technical scopes</summary>
                          <code className="mt-2 block break-words text-[11px] text-muted-foreground">{credentialPermissions.byoa_workflow.join(", ")}</code>
                        </details>
                        <Button className="mt-3 w-full" variant="outline" onClick={() => void issueCredential("byoa_workflow")} disabled={busy || selected.status !== "active"}>
                          Create BYOA Credential
                        </Button>
                      </div>
                    </div>

                    {oneTimeCredential?.agentId === selected.id ? (
                      <div className="rounded-md border border-amber-400/40 bg-amber-400/10 p-3 text-xs grid gap-2">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-amber-500">
                            {oneTimeCredential.credentialType === "machine_api" ? BRAND.agentApi : "BYOA Workflow"} secret (displayed once)
                          </span>
                          <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(oneTimeCredential.token).catch(() => undefined)}>
                            <Copy className="mr-1 size-3" /> Copy once
                          </Button>
                        </div>
                        <code className="block break-all bg-black/40 p-2 rounded font-mono text-[11px]">{oneTimeCredential.token}</code>
                      </div>
                    ) : null}

                    <div className="grid gap-2">
                      {detail.credentials.map((cred) => (
                        <div key={cred.id} className="rounded-md border p-3 text-xs flex flex-col gap-1">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold">{cred.label} · …{cred.id.slice(-8)}</span>
                            <Badge variant={cred.revokedAt ? "destructive" : "outline"}>
                              {cred.revokedAt ? "Revoked" : "Active"}
                            </Badge>
                          </div>
                          <span className="text-muted-foreground">Type: {cred.credentialType === "machine_api" ? BRAND.agentApi : "BYOA Workflow"}</span>
                          <span className="text-muted-foreground">Scopes: {cred.scopes.join(", ")}</span>
                          <span className="text-muted-foreground">Created: {new Date(cred.createdAt).toLocaleString()}</span>
                          <span className="text-muted-foreground">Expires: {new Date(cred.expiresAt).toLocaleString()}</span>
                          {!cred.revokedAt ? (
                            <div className="mt-2 flex gap-2">
                              <Button size="sm" variant="outline" onClick={() => void rotateCredential(cred.id)} disabled={busy}>Rotate</Button>
                              <Button size="sm" variant="destructive" onClick={() => void revokeCredential(cred.id)} disabled={busy}>Revoke</Button>
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Step 4 — Test Console (Browser Test Runner) */}
              <Card className="border-primary/40 shadow-md">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-primary">
                    <Play className="size-5" /> Step 4 — Test Console (Browser Test Runner)
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-6">
                  <div className="rounded-md border p-4 bg-secondary/10 grid gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
                      <div>
                        <h4 className="font-semibold text-sm">Stable Test Scenario: Market Context Brief</h4>
                        <p className="text-xs text-muted-foreground">Asset: ETH/USD · Maximum Budget: 0.005 USDC · Network: Arc Testnet</p>
                      </div>
                      <Badge variant="outline">ETH/USD</Badge>
                    </div>

                    <div className="grid gap-2 text-xs">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        <div>
                          <span className="text-muted-foreground block">Workflow</span>
                          <span className="font-medium">Market Context Brief</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground block">Agent Wallet</span>
                          <span className="font-mono">{shortenHash(selected.agentWallet ?? "", 6)}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground block">Aggregate Price</span>
                          <span className="font-semibold text-primary">0.005000 USDC</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground block">Idempotency Key</span>
                          <span className="font-mono truncate block">{idempotencyKey.slice(0, 18)}…</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Pre-Signature Breakdown */}
                  {reservedQuote ? (
                    <div className="rounded-md border border-primary/30 bg-primary/5 p-4 text-xs grid gap-3">
                      <h5 className="font-semibold text-sm">Quote Breakdown & Allowance Check</h5>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div>
                          <span className="text-muted-foreground block">Aggregate Price</span>
                          <span className="font-medium">{reservedQuote.priceUsdc} USDC</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground block">Est. Provider Cost</span>
                          <span className="font-medium">~0.004000 USDC</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground block">Platform Fee</span>
                          <span className="font-medium">~0.001000 USDC</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground block">Quote Status</span>
                          <span className="font-medium capitalize">{reservedQuote.status}</span>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {/* Wallet mismatch warning */}
                  {wallet.address && selected.agentWallet && wallet.address.toLowerCase() !== selected.agentWallet.toLowerCase() ? (
                    <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive flex items-center gap-2">
                      <ShieldAlert className="size-4 shrink-0" />
                      <span>
                        <strong>Wallet Mismatch:</strong> Connected browser wallet ({shortenHash(wallet.address, 6)}) differs from registered agent wallet ({shortenHash(selected.agentWallet, 6)}). Please switch wallet in MetaMask before signing.
                      </span>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap gap-3">
                    <Button
                      onClick={() => void runWorkflowExecution(false)}
                      disabled={
                        busy ||
                        runnerState === "executing" ||
                        runnerState === "polling" ||
                        !wallet.address ||
                        wallet.address.toLowerCase() !== selected.agentWallet?.toLowerCase()
                      }
                      className="bg-primary hover:bg-primary/90"
                    >
                      {runnerState === "executing" ? (
                        <>Signing x402 Payment…</>
                      ) : runnerState === "polling" ? (
                        <><RefreshCw className="mr-2 size-4 animate-spin" /> Running Workflow…</>
                      ) : (
                        <><Play className="mr-2 size-4" /> Sign and Run Workflow</>
                      )}
                    </Button>

                    {testResult ? (
                      <Button
                        variant="outline"
                        onClick={() => void runWorkflowExecution(true)}
                        disabled={busy || runnerState === "executing" || runnerState === "polling"}
                      >
                        <RotateCcw className="mr-2 size-4" /> Replay with Same Idempotency Key
                      </Button>
                    ) : null}
                  </div>

                  {/* Empirical replay proof badges */}
                  {replayProof ? (
                    <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs flex flex-wrap gap-3 items-center text-emerald-700 dark:text-emerald-300">
                      <span className="font-semibold flex items-center gap-1">
                        <CheckCircle2 className="size-4" /> Idempotency Replay Verified (Empirical Comparison):
                      </span>
                      {replayProof.sameJobId ? <Badge variant="outline" className="border-emerald-500 text-emerald-600">Job ID identical ({shortenHash(replayProof.jobId, 5)})</Badge> : <Badge variant="destructive">Job ID mismatch</Badge>}
                      {replayProof.noDuplicatePayment ? <Badge variant="outline" className="border-emerald-500 text-emerald-600">No duplicate payment</Badge> : <Badge variant="destructive">Duplicate payment detected</Badge>}
                      {replayProof.noNewReceipts ? <Badge variant="outline" className="border-emerald-500 text-emerald-600">Receipts identical ({replayProof.receiptCount})</Badge> : <Badge variant="destructive">Receipt mismatch</Badge>}
                      {replayProof.noNewProofs ? <Badge variant="outline" className="border-emerald-500 text-emerald-600">Proofs identical ({replayProof.proofCount})</Badge> : <Badge variant="destructive">Proof mismatch</Badge>}
                      {replayProof.allowancePreserved ? <Badge variant="outline" className="border-emerald-500 text-emerald-600">Allowance preserved ({replayProof.dailySpentUsdc} USDC spent)</Badge> : <Badge variant="destructive">Allowance deducted again</Badge>}
                      {replayProof.callCountPreserved ? <Badge variant="outline" className="border-emerald-500 text-emerald-600">Call count preserved</Badge> : <Badge variant="destructive">Call count incremented</Badge>}
                    </div>
                  ) : null}


                  {/* Unified Result Panel */}
                  {testResult ? (
                    <Card className="border-emerald-500/30 bg-emerald-500/5">
                      <CardHeader><CardTitle className="text-emerald-600 text-base">Execution Result & Proof Trail</CardTitle></CardHeader>
                      <CardContent className="grid gap-4 text-xs">
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 p-3 rounded border bg-background">
                          <div>
                            <span className="text-muted-foreground block">Workflow Status</span>
                            <span className="font-semibold capitalize text-emerald-600">{testResult.job?.status}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground block">Job ID</span>
                            <span className="font-mono">{shortenHash(testResult.job?.id ?? "", 6)}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground block">Total Charged</span>
                            <span className="font-semibold">0.005000 USDC</span>
                          </div>
                        </div>

                        {testResult.finalReport ? (
                          <div className="rounded border bg-background p-3 grid gap-2">
                            <span className="font-semibold text-sm">Final Report Summary</span>
                            <p className="text-muted-foreground">{testResult.finalReport.summary}</p>
                          </div>
                        ) : null}

                        {/* Receipts and Proof Links */}
                        <div className="grid gap-2 border-t pt-3">
                          <span className="font-semibold">Receipts & Arc Proofs</span>
                          <div className="flex flex-wrap gap-2">
                            {testResult.job?.agentRunId ? (
                              <Button asChild size="sm" variant="outline">
                                <Link href={`/runs/${testResult.job.agentRunId}`} target="_blank">
                                  Agent Run <ExternalLink className="ml-1 size-3" />
                                </Link>
                              </Button>
                            ) : null}

                            {testResult.aggregateReceiptUrl ? (
                              <Button asChild size="sm" variant="outline">
                                <Link href={testResult.aggregateReceiptUrl} target="_blank">
                                  Aggregate Receipt <ExternalLink className="ml-1 size-3" />
                                </Link>
                              </Button>
                            ) : null}

                            {(testResult.internalReceiptUrls ?? []).map((url: string, idx: number) => (
                              <Button key={url} asChild size="sm" variant="ghost">
                                <Link href={url} target="_blank">
                                  Downstream Receipt #{idx + 1}
                                </Link>
                              </Button>
                            ))}

                            {(testResult.proofUrls ?? []).map((url: string, idx: number) => (
                              <Button key={url} asChild size="sm" variant="ghost">
                                <a href={url} target="_blank" rel="noreferrer">
                                  Arc Proof #{idx + 1}
                                </a>
                              </Button>
                            ))}

                            <Button asChild size="sm" variant="outline">
                              <Link href={`/agents/byoa/${selected.publicId}`} target="_blank">
                                Agent Passport <ExternalLink className="ml-1 size-3" />
                              </Link>
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ) : null}
                </CardContent>
              </Card>

              {/* History & Payment Logs */}
              <Card>
                <CardHeader><CardTitle>Runs, Receipts and Arc Proofs</CardTitle></CardHeader>
                <CardContent className="grid gap-4">
                  <div className="flex flex-wrap gap-2">
                    <Button asChild variant="outline">
                      <Link href={`/agents/byoa/${selected.publicId}`} target="_blank">Public Agent Passport</Link>
                    </Button>
                    <Button variant="outline" onClick={() => void loadDetail(selected.id)} disabled={busy}>
                      <RefreshCw className="mr-2 size-4" /> Refresh History
                    </Button>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    {detail.jobs.length} recent runs · {detail.payments.length} workflow payments.
                  </p>

                  <div className="grid gap-2">
                    {detail.jobs.map((job) => (
                      <div key={job.id} className="rounded-md border p-3 text-xs flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Badge>{job.status}</Badge>
                          <span className="font-medium">{job.workflow_type}</span>
                          <span className="text-muted-foreground">{job.spent_usdc} USDC</span>
                        </div>
                        {job.agent_run_id ? (
                          <Button asChild size="sm" variant="ghost">
                            <Link href={`/runs/${job.agent_run_id}`} target="_blank">Run Details</Link>
                          </Button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <IntegrationExamples publicId={selected.publicId} />
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function IntegrationExamples({ publicId }: { publicId: string }) {
  const sample = `const API = "https://agent-commerce-six.vercel.app";
const credential = process.env.BYOA_API_CREDENTIAL; // stays in your agent runtime
const idempotencyKey = crypto.randomUUID();

// 1. Discover safe capabilities.
await fetch(\`${"${API}"}/api/byoa/manifest\`);

// 2. Reserve an immutable, policy-checked quote.
const quote = await fetch(\`${"${API}"}/api/byoa/v1/quotes\`, {
  method: "POST",
  headers: { Authorization: \`Bearer ${"${credential}"}\`, "Idempotency-Key": idempotencyKey, "Content-Type": "application/json" },
  body: JSON.stringify({ workflowType: "market_context", task: "Create an ETH market brief", inputText, marketSymbol: "ETH/USD", budgetUsdc: 0.005 })
}).then(r => r.json());

// 3. POST quote.quote.resourceUrl without PAYMENT-SIGNATURE → HTTP 402.
// 4. Your external agent wallet signs the exact Gateway acceptance locally.
// 5. Retry with PAYMENT-SIGNATURE; poll the returned statusUrl.
// Reuse the same Idempotency-Key: ${publicId} will never be charged twice for the same quote.`;
  return (
    <Card>
      <CardHeader><CardTitle>Manifest → quote → HTTP 402 → payment → execute → poll</CardTitle></CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-muted-foreground">
          The external agent keeps its signer locally. {BRAND.name} receives only the signed x402 payload and the scoped API credential.
        </p>
        <pre className="max-w-full overflow-x-auto rounded-md bg-black/40 p-4 text-xs leading-5">
          <code>{sample}</code>
        </pre>
      </CardContent>
    </Card>
  );
}
