"use client";
import { WalletControl } from "./wallet-control";
export function ConnectChip(props: {
  verified?: boolean | null;
  onVerify?: () => void;
  verifying?: boolean;
}) {
  return <WalletControl {...props} compact />;
}
