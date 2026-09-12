# Agent-Commerce — Agent Instructions

Veyra is a workflow-first hosted workflow and verification layer on Arc Testnet.

The primary product is not a generic API marketplace demo. A user selects a workflow, submits real non-sensitive input, receives an immutable quote, uses sponsored quota or confirms one workflow-level USDC payment, and receives a Final Report, aggregate workflow receipt, and Arc proof trail after the hosted agent purchases allowlisted x402 services.

Legacy API Store, Agent Launch, Agent Setup, and local CLI surfaces remain available under Developer Tools.

## Required MCP usage

Before Arc-specific development, verify that the Arc Docs MCP server is available.

Arc Docs MCP:

- name: `arc-docs`
- URL: `https://docs.arc.io/mcp`

Use Arc Docs MCP for current Arc-specific facts, APIs, contract addresses, standards, and developer flows.

Use Circle MCP for current Circle SDK and API details:

- name: `circle`
- URL: `https://api.circle.com/v1/codegen/mcp`

If required live documentation is unavailable, stop and report the limitation before making new Arc-, Circle-, payment-, or contract-specific decisions. A narrow compatibility fix to an already accepted flow may continue only when the installed official SDK types or examples and a redacted live provider validation response independently demonstrate the same required payload shape. Such a fallback must not change networks, contract addresses, assets, amounts, recipients, settlement policy, or custody boundaries. Local `docs.md` alone is fallback context only.

## Local skills

Before changing Arc, Circle, USDC, Gateway, x402, agent-wallet, payment, or contract behavior, use the relevant skills under `.agents/skills`.

Most relevant skills:

- `use-arc`
- `use-usdc`
- `use-gateway`
- `use-agent-wallet`
- `pay-via-agent-wallet`
- `fund-agent-wallet`
- `agent-wallet-policy`
- `use-smart-contract-platform`
- `use-developer-controlled-wallets`

## Product invariants

Preserve these boundaries unless the accepted issue-spec explicitly changes them:

- browser-hosted workflow execution is the primary product;
- the user sees one immutable workflow quote before checkout;
- sponsored authorization and paid checkout remain separate paths;
- user payment accounting remains separate from downstream x402 provider payments;
- downstream purchases use the project-owned hosted payer;
- service selection stays allowlisted and budget-bounded;
- idempotency, cooldown, rate limiting, and active-job controls remain enforced;
- successful provider calls remain linked to receipts, reports, passports, seller analytics, and Arc proofs;
- deterministic fallback remains valid when optional LLM synthesis fails;
- public surfaces never persist full prompts, secrets, authorization headers, raw provider errors, or raw provider payloads;
- Arc is testnet-only and contracts are not presented as audited.

## Safety rules

Even with `--dangerously-skip-permissions`, agents must never:

- read, print, copy, commit, or expose `.env`, `.env.*`, private keys, wallet secrets, Circle keys, entity secrets, bearer tokens, cookies, seed phrases, or signing material;
- run `git reset --hard`, `git clean -fd`, destructive database commands, destructive contract operations, or mass deletion;
- push, force-push, merge, deploy, publish, send transactions, fund wallets, or mutate production without the user's explicit instruction for that exact action;
- edit outside the repository;
- overwrite unrelated dirty-tree work;
- install dependencies unless the issue-spec allows it;
- rewrite payment, Gateway, x402, wallet, proof, or Supabase logic unless the issue-spec explicitly requires it.

Before implementation, run:

```bash
git status -sb
git diff --stat
git branch --show-current
```

Prefer small, reviewable changes. Run the issue-spec checks after implementation. Do not push without explicit user approval.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
