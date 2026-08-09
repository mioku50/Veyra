import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseUnits,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  ARC_MEMO_ABI,
  ARC_TESTNET_MEMO_ADDRESS,
  ARC_USDC_TRANSFER_ABI,
} from "../wallet/arc-usdc.ts";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_USDC_ADDRESS,
} from "../wallet/arc.ts";

export const ARC_MEMO_WORKFLOW_PAYMENT_PROTOCOL = "arc_memo_erc20_v1" as const;
export const ARC_LEGACY_WORKFLOW_PAYMENT_PROTOCOL = "arc_native_usdc_v1" as const;
const ARC_NATIVE_USDC_SCALE = BigInt(10) ** BigInt(12);

export type WorkflowPaymentProtocol =
  | typeof ARC_MEMO_WORKFLOW_PAYMENT_PROTOCOL
  | typeof ARC_LEGACY_WORKFLOW_PAYMENT_PROTOCOL;

export type WorkflowPaymentDescriptor = {
  protocol: WorkflowPaymentProtocol;
  chainId: typeof ARC_TESTNET_CHAIN_ID;
  asset: "native_usdc";
  amountAtomic6: string;
  treasuryAddress: Address;
  memo: null | {
    contractAddress: typeof ARC_TESTNET_MEMO_ADDRESS;
    targetAddress: typeof ARC_TESTNET_USDC_ADDRESS;
    memoId: Hex;
    memoData: Hex;
    callDataHash: Hex;
  };
};

export type WorkflowPaymentQuoteSource = {
  id: string;
  request_hash: string;
  input_hash: string;
  requester_wallet: string;
  treasury_address: string;
  amount_due_usdc: string | number;
  expires_at: string;
  planner_snapshot: Record<string, unknown>;
};

function quoteMetadata(quote: WorkflowPaymentQuoteSource) {
  const metadata = quote.planner_snapshot?.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

export function workflowPaymentProtocolForQuote(
  quote: WorkflowPaymentQuoteSource,
): WorkflowPaymentProtocol {
  return quoteMetadata(quote).checkout_payment_protocol === ARC_MEMO_WORKFLOW_PAYMENT_PROTOCOL
    ? ARC_MEMO_WORKFLOW_PAYMENT_PROTOCOL
    : ARC_LEGACY_WORKFLOW_PAYMENT_PROTOCOL;
}

export function workflowPaymentMemoId(quoteId: string): Hex {
  return keccak256(stringToHex(`veyra:workflow-quote:${quoteId}`));
}

export function workflowPaymentCommitment(
  quote: WorkflowPaymentQuoteSource,
): Hex {
  const amountAtomic6 = parseUnits(String(quote.amount_due_usdc), 6).toString();
  const canonical = [
    "veyra.workflow-payment.v1",
    quote.id,
    String(ARC_TESTNET_CHAIN_ID),
    getAddress(quote.requester_wallet).toLowerCase(),
    getAddress(quote.treasury_address).toLowerCase(),
    amountAtomic6,
    quote.request_hash.toLowerCase(),
    quote.input_hash.toLowerCase(),
    quote.expires_at,
  ].join("\n");
  return keccak256(stringToHex(canonical));
}

export function workflowPaymentDescriptor(
  quote: WorkflowPaymentQuoteSource,
): WorkflowPaymentDescriptor {
  const protocol = workflowPaymentProtocolForQuote(quote);
  const amountAtomic6 = parseUnits(String(quote.amount_due_usdc), 6);
  const treasuryAddress = getAddress(quote.treasury_address);
  if (protocol === ARC_LEGACY_WORKFLOW_PAYMENT_PROTOCOL) {
    return {
      protocol,
      chainId: ARC_TESTNET_CHAIN_ID,
      asset: "native_usdc",
      amountAtomic6: amountAtomic6.toString(),
      treasuryAddress,
      memo: null,
    };
  }
  const innerData = encodeFunctionData({
    abi: ARC_USDC_TRANSFER_ABI,
    functionName: "transfer",
    args: [treasuryAddress, amountAtomic6],
  });
  return {
    protocol,
    chainId: ARC_TESTNET_CHAIN_ID,
    asset: "native_usdc",
    amountAtomic6: amountAtomic6.toString(),
    treasuryAddress,
    memo: {
      contractAddress: ARC_TESTNET_MEMO_ADDRESS,
      targetAddress: ARC_TESTNET_USDC_ADDRESS,
      memoId: workflowPaymentMemoId(quote.id),
      memoData: workflowPaymentCommitment(quote),
      callDataHash: keccak256(innerData),
    },
  };
}

export function encodeWorkflowPaymentTransaction(
  descriptor: WorkflowPaymentDescriptor,
): { to: Address; value: bigint; data: Hex; innerData: Hex | null } {
  const amountAtomic6 = BigInt(descriptor.amountAtomic6);
  if (!descriptor.memo) {
    return {
      to: descriptor.treasuryAddress,
      value: amountAtomic6 * ARC_NATIVE_USDC_SCALE,
      data: "0x",
      innerData: null,
    };
  }
  const innerData = encodeFunctionData({
    abi: ARC_USDC_TRANSFER_ABI,
    functionName: "transfer",
    args: [descriptor.treasuryAddress, amountAtomic6],
  });
  return {
    to: descriptor.memo.contractAddress,
    value: BigInt(0),
    data: encodeFunctionData({
      abi: ARC_MEMO_ABI,
      functionName: "memo",
      args: [
        descriptor.memo.targetAddress,
        innerData,
        descriptor.memo.memoId,
        descriptor.memo.memoData,
      ],
    }),
    innerData,
  };
}

export function workflowPaymentTransactionRequest(
  descriptor: WorkflowPaymentDescriptor | null,
) {
  if (!descriptor) return null;
  const transaction = encodeWorkflowPaymentTransaction(descriptor);
  return {
    protocol: descriptor.protocol,
    chainId: descriptor.chainId,
    to: transaction.to,
    value: toHex(transaction.value),
    data: transaction.data,
    memo: descriptor.memo,
  };
}

export function decodeWorkflowMemoTransaction(data: Hex) {
  const outer = decodeFunctionData({ abi: ARC_MEMO_ABI, data });
  if (outer.functionName !== "memo") throw new Error("Unexpected Memo function.");
  const [target, innerData, memoId, memoData] = outer.args;
  const inner = decodeFunctionData({
    abi: ARC_USDC_TRANSFER_ABI,
    data: innerData as Hex,
  });
  if (inner.functionName !== "transfer") throw new Error("Unexpected USDC function.");
  const [recipient, amount] = inner.args;
  return {
    target: getAddress(target as Address),
    innerData: innerData as Hex,
    memoId: memoId as Hex,
    memoData: memoData as Hex,
    recipient: getAddress(recipient as Address),
    amount: amount as bigint,
  };
}
