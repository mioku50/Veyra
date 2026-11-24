# veyra-trust-guard

Fail-closed `fetch` wrapper that checks Veyra's free Arc Mainnet preflight (`POST /api/x402/v1/verdict`) whenever an endpoint answers with HTTP `402 Payment Required` before your x402 client signs or sends USDC.

> `preflight.result === "pass"` means **no concrete blocking fact was observed** (endpoint reachable, valid Arc Mainnet USDC HTTP `402` challenge, within budget, payee matches catalog and last saved check). **It is not an endorsement and says nothing about post-payment delivery.**

By default `onVeyraUnavailable` is `"block"` (fail-closed). Pass `onVeyraUnavailable: "allow"` only if you explicitly accept paying when Veyra cannot be reached.

## Example: wrapping an x402 `fetch` client

```ts
import { createGuardedFetch, VeyraBlockedError } from "veyra-trust-guard";

const safeFetch = createGuardedFetch({ budgetUsdc: 0.25 });
// Pass `safeFetch` to your x402 payment wrapper (e.g. wrapFetchWithPayment(safeFetch, signer))
const res = await safeFetch("https://api.aisa.one/apis/v2/apollo/labels", { method: "GET" });
// If preflight returns "block" or Veyra is unavailable, VeyraBlockedError is thrown before payment.
// If preflight returns "pass", the untouched HTTP 402 response flows to the x402 client.
```

## Example: inside a Vercel AI SDK tool

```ts
import { tool } from "ai";
import { z } from "zod";
import { guardedFetch } from "veyra-trust-guard";

export const callPaidEndpoint = tool({
  description: "Call an x402 endpoint with Veyra preflight check.",
  parameters: z.object({ url: z.string().url() }),
  execute: async ({ url }) => guardedFetch(url, { method: "GET" }, { budgetUsdc: 0.25 }).then((r) => r.text()),
});
```
