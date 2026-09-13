"use client";

/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useSyncExternalStore } from "react";
import { useArcWallet } from "./use-arc-wallet";

/* One chip that always says what the wallet is actually doing.
 *
 * The decision screen had no wallet control at all, and on a phone pressing
 * connect did nothing visible: mobile browsers inject no EVM provider, so
 * `connect()` set an error string that nothing on the page rendered. A wallet
 * app's own browser does inject one, so the honest answer on a phone is a link
 * that reopens this page inside it. */

/* Read through useSyncExternalStore rather than an effect: the value never
   changes after hydration, and the server snapshot is deliberately false so the
   desktop branch renders identically on both sides. */
const NO_OP_SUBSCRIBE = () => () => {};

function isProbablyMobile() {
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

function walletDeepLinks() {
  if (typeof window === "undefined") return [];
  const { host, pathname, search, href } = window.location;
  return [
    { label: "MetaMask", href: `https://metamask.app.link/dapp/${host}${pathname}${search}` },
    { label: "Coinbase Wallet", href: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(href)}` },
    { label: "Trust Wallet", href: `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(href)}` },
  ];
}

function short(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function ConnectChip({
  verified,
  onVerify,
  verifying = false,
}: {
  /** Undefined when the surface does not care about an owner session. */
  verified?: boolean | null;
  onVerify?: () => void;
  verifying?: boolean;
}) {
  const wallet = useArcWallet();
  const mobile = useSyncExternalStore(NO_OP_SUBSCRIBE, isProbablyMobile, () => false);
  const [openLinks, setOpenLinks] = useState(false);

  const base =
    "run-focus inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[12px] font-medium transition-colors";
  const idle = `${base} border-[var(--run-line-strong)] bg-[var(--run-canvas-raised)] text-[var(--run-text-muted)] hover:text-[var(--run-text)]`;
  const call = `${base} border-transparent text-white`;
  const callStyle = { background: "linear-gradient(180deg,var(--run-accent),var(--run-accent-deep))" };

  // No injected provider. On a phone that is normal and fixable; on a desktop
  // it means no wallet extension is installed.
  if (!wallet.providerAvailable) {
    if (!mobile) {
      return (
        <a href="https://metamask.io/download/" target="_blank" rel="noreferrer" className={idle}>
          Install a wallet
        </a>
      );
    }
    return (
      <div className="relative">
        <button type="button" onClick={() => setOpenLinks((v) => !v)} className={call} style={callStyle}>
          Open in wallet app
        </button>
        {openLinks ? (
          <div className="run-panel absolute right-0 z-50 mt-2 w-52 overflow-hidden p-1">
            <p className="px-2.5 py-2 text-[11px] leading-relaxed text-[var(--run-text-faint)]">
              A phone browser has no wallet built in. Reopen this page inside your wallet&apos;s browser:
            </p>
            {walletDeepLinks().map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="run-focus block rounded-[6px] px-2.5 py-2 text-[12.5px] text-[var(--run-text)] hover:bg-[var(--run-surface-hover)]"
              >
                {link.label}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  if (!wallet.address) {
    return (
      <button
        type="button"
        onClick={() => void wallet.connect()}
        disabled={wallet.connecting}
        className={call}
        style={callStyle}
      >
        {wallet.connecting ? "Opening wallet…" : "Connect wallet"}
      </button>
    );
  }

  if (!wallet.isArcTestnet) {
    return (
      <button
        type="button"
        onClick={() => void wallet.switchToArc()}
        disabled={wallet.switching}
        className={`${base} border-[rgba(255,179,64,0.35)] bg-[var(--run-amber-wash)] text-[var(--run-amber)]`}
      >
        {wallet.switching ? "Switching…" : "Switch to Arc"}
      </button>
    );
  }

  if (verified === false && onVerify) {
    return (
      <button type="button" onClick={onVerify} disabled={verifying} className={call} style={callStyle}>
        {verifying ? "Waiting for signature…" : "Verify wallet"}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => wallet.disconnect()}
      title="Disconnect"
      className={`${base} border-[rgba(77,208,255,0.28)] bg-[var(--run-azure-wash)] text-[var(--run-azure)]`}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--run-azure)]" />
      <span className="run-num">{short(wallet.address)}</span>
    </button>
  );
}
