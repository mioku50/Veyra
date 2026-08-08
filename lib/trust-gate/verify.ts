import { recoverTypedDataAddress, type Hex } from "viem";
import { EIP712_CLEARANCE_TYPES, getTrustGateEip712Domain } from "./sign.ts";
import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";

export async function verifyTrustClearanceOffchain(
  clearanceMessage: any,
  signature: Hex,
  domain: ReturnType<typeof getTrustGateEip712Domain>,
  expectedAttester?: `0x${string}`
) {
  try {
    const signer = await recoverTypedDataAddress({
      domain,
      types: EIP712_CLEARANCE_TYPES,
      primaryType: "TrustClearance",
      message: clearanceMessage,
      signature,
    });

    const now = BigInt(Math.floor(Date.now() / 1000));
    if (clearanceMessage.expiresAt < now) {
      return { valid: false, signer, reason: "Expired" };
    }

    if (expectedAttester && signer.toLowerCase() !== expectedAttester.toLowerCase()) {
      return { valid: false, signer, reason: "Signer mismatch" };
    }

    return { valid: true, signer };
  } catch (err: any) {
    return { valid: false, reason: err.message };
  }
}

export async function verifyTrustClearanceOnchain(
  clearanceMessage: any,
  signature: Hex,
  trustGateAddress: `0x${string}`,
  rpcUrl?: string
) {
  const client = createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl || process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network"),
  });

  try {
    const [valid, signer] = await client.readContract({
      address: trustGateAddress,
      abi: [
        {
          inputs: [
            {
              components: [
                { name: "decisionId", type: "bytes32" },
                { name: "subject", type: "address" },
                { name: "executor", type: "address" },
                { name: "counterparty", type: "address" },
                { name: "actionHash", type: "bytes32" },
                { name: "requestedAmount", type: "uint256" },
                { name: "maxAmount", type: "uint256" },
                { name: "snapshotHash", type: "bytes32" },
                { name: "policyVersion", type: "bytes32" },
                { name: "evaluator", type: "address" },
                { name: "issuedAt", type: "uint64" },
                { name: "expiresAt", type: "uint64" },
              ],
              name: "clearance",
              type: "tuple",
            },
            { name: "signature", type: "bytes" },
          ],
          name: "verifyClearance",
          outputs: [
            { name: "valid", type: "bool" },
            { name: "signer", type: "address" },
          ],
          stateMutability: "view",
          type: "function",
        },
      ],
      functionName: "verifyClearance",
      args: [clearanceMessage, signature],
    }) as [boolean, `0x${string}`];

    return { valid, signer };
  } catch (err: any) {
    return { valid: false, reason: err.message };
  }
}
