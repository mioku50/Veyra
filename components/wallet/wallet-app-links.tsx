"use client";

/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useSyncExternalStore } from "react";

/**
 * What to offer when there is no wallet to connect to.
 *
 * A phone browser injects no EVM provider. `connect()` knows this -- it sets an
 * error string and returns -- but a screen that renders neither the error nor
 * an alternative turns every wallet button into a button that does nothing when
 * pressed. That dead end was found once on the decision screen and fixed there;
 * these helpers exist so the fix is a shared thing rather than a thing one
 * screen happens to have.
 *
 * A wallet app's own browser does inject a provider, so the honest answer on a
 * phone is a link that reopens this page inside it. On a desktop the same
 * absence means something else entirely -- no extension is installed -- and the
 * two must not be offered the same answer.
 */

/* Read through useSyncExternalStore rather than an effect: the value never
   changes after hydration, and the server snapshot is deliberately false so the
   desktop branch renders identically on both sides. */
const NO_OP_SUBSCRIBE = () => () => {};

function readIsMobile() {
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

export function useIsProbablyMobile() {
  return useSyncExternalStore(NO_OP_SUBSCRIBE, readIsMobile, () => false);
}

export type WalletAppLink = { label: string; href: string };

/**
 * Deep links that reopen the current page inside a wallet's own browser.
 *
 * Built from `window.location` at press time rather than from a configured base
 * URL, so a preview deployment links back to itself instead of sending the
 * person to production with none of their state.
 */
export function walletDeepLinks(): WalletAppLink[] {
  if (typeof window === "undefined") return [];
  const { host, pathname, search, href } = window.location;
  return [
    { label: "MetaMask", href: `https://metamask.app.link/dapp/${host}${pathname}${search}` },
    { label: "Coinbase Wallet", href: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(href)}` },
    { label: "Trust Wallet", href: `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(href)}` },
  ];
}

/**
 * The replacement for a wallet button that cannot work.
 *
 * Rendered in place of "Connect", never beside it: a disabled-looking button
 * next to a working alternative reads as two ways to do the same thing, and the
 * one a person tries first is the one that does nothing.
 */
export function NoWalletHere({ what }: { what: string }) {
  const mobile = useIsProbablyMobile();
  const [open, setOpen] = useState(false);

  if (!mobile) {
    return (
      <div className="space-y-1.5">
        <a
          href="https://metamask.io/download/"
          target="_blank"
          rel="noreferrer"
          className="inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
        >
          Install a wallet
        </a>
        <p className="text-xs text-muted-foreground">
          This browser has no wallet extension, so there is nothing to ask for a signature.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
      >
        Open in your wallet app
      </button>
      <p className="text-xs text-muted-foreground">
        A phone browser has no wallet built in, so {what} cannot be signed here. Reopen this page
        inside your wallet&apos;s own browser and it will work.
      </p>
      {open ? (
        <div className="mt-1 inline-flex flex-wrap gap-1.5">
          {walletDeepLinks().map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted"
            >
              {link.label}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
