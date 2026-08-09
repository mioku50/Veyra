# Veyra

Verified workflows for people and AI agents.

Veyra lets people and autonomous agents run paid data and analysis workflows,
receive structured reports, and verify results on Arc.

[Run a workflow](https://agent-commerce-six.vercel.app/agent-runner) ·
[Monitor trust](https://agent-commerce-six.vercel.app/monitoring) ·
[Browse reports](https://agent-commerce-six.vercel.app/results) ·
[Veyra Agent API](https://agent-commerce-six.vercel.app/console/agent-api)

## Flagship workflow

GitHub Project Due Diligence turns a public repository URL into an
evidence-backed report with:

- live repository, activity, release, contributor, and governance data;
- deterministic engineering-quality and adoption-risk analysis;
- a clear verdict with confidence and evidence coverage;
- JSON and Markdown export plus a shareable report URL;
- receipts and Arc Testnet proof links for paid workflow steps.

The verdict is repository-health guidance, not a security audit or investment
recommendation.

## Continuous Trust Monitoring

One report is a snapshot. Veyra watchlists turn public projects and agents into
an Arc-verifiable history:

```text
watchlist → manual/daily/weekly recheck → canonical snapshot → delta → Arc proof
```

Delta reports surface score movement, new and resolved risks, repository
activity, agent status, endpoint availability, service reliability, contract
changes, and verification coverage without repeating an unchanged full report.
The Public App and Veyra Agent API use the same deterministic delta model.

Each explicitly published subject gets one canonical, wallet-free Trust Profile
at `/trust/vtr_...`. The page renders real snapshot scores, meaningful changes,
the exact Arc proof for every snapshot, a full-report link, and a share preview.
Equivalent GitHub URLs and normalized endpoint, wallet, contract, or agent
identifiers converge on the same stable profile. Private watchlists and unknown
profiles both return the same 404 response.

Public profiles also expose server-rendered, snapshot-aware SVG badges for
README files and websites plus a compact public status endpoint. Meaningful
changes create in-app alerts and can be delivered as signed, retryable,
SSRF-protected webhooks.

## Two product paths

People use the Public App:

```text
workflow → immutable quote → sponsored or USDC checkout → report → Arc proof
```

AI agents use Veyra Agent API v1:

```text
discover → quote → idempotent run → poll → structured report
```

Project 360 uses an explicit safety boundary:

```text
free source discovery → user-confirmed candidates → transparent module quote
→ one confirmation → isolated module execution → aggregate Arc proof
```

The Veyra Agent API includes a typed dependency-free TypeScript SDK, normalized
errors, strict credential isolation, an OpenAPI specification, and a runnable
GitHub Due Diligence agent example.

- [Veyra Agent API guide](docs/agent-api.md)
- [TypeScript SDK](sdk/typescript)
- [Production-ready agent example](examples/machine-agent/github-due-diligence-agent.ts)
- [OpenAPI specification](public/openapi/agent-commerce-v1.json)
- [Trust webhooks and HMAC verification](docs/webhooks.md)

## Curated workflows

| Workflow | Result | Starting provider cost |
| --- | --- | ---: |
| GitHub Project Due Diligence | Repository-health verdict and evidence report | 0.002 USDC |
| Veyra Agent Trust Report | Identity, code, execution, payment, service, and Arc trust signals | 0.0004 USDC |
| Veyra Project 360 Due Diligence | Explicitly selected multi-source evidence, coverage-aware score, 15-section report, and one aggregate Arc proof | Per selected module |
| Treasury Health | Wallet balance, concentration, activity, and runway signals | 0.0004 USDC |
| Paid API Quality | Observed availability, latency, response, payment, and settlement quality | 0.002 USDC |
| Market Context Brief | Live provider-backed market snapshot | 0.0013 USDC |
| Sentiment & Tone Report | Structured sentiment and tone signals | 0.0013 USDC |
| Builder Update Summary | Delivery summary, signals, and next steps | 0.0013 USDC |

External seller commerce remains an internal capability. It is not the primary
catalog or product positioning.

## Local development

```bash
git clone https://github.com/mioku50/Agent-Commerce.git
cd Agent-Commerce
npm install
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Common verification:

```bash
npm run lint
npm run machine:sdk-build
npm run github:analysis-test
npm run monitoring:test
npm run trust-profile:test
npm run webhooks:test
npm run project-360:test
npm run machine:api-test
npm run operations:test
npm run build
```

## Operations and safety

The production console aggregates execution failures, provider latency,
checkout failures, and Arc proof delays. Paid provider calls are never blindly
retried; quote/run idempotency and existing payment records are reconciled
before recovery.

Public surfaces do not publish full prompts, credentials, authorization
headers, raw provider errors, or raw provider payloads.

Veyra currently runs on Arc Testnet (`5042002`). Contracts are
experimental and are not presented as audited.

## Stack

Next.js, TypeScript, Supabase, Arc Testnet, USDC, x402, GitHub API, and Vercel.

## License and attribution

Licensed under the [Apache License 2.0](LICENSE). Redistributions and derivative
works must retain required notices and identify modified files.

The project name, original branding, logo, screenshots, and visual identity are
not licensed for reuse. Do not present a fork as the original product or imply
endorsement by its author.

Copyright © 2026 Sergio Romanov
([@mioku50](https://github.com/mioku50)).
