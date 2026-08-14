# Contributing to Veyra

Thank you for your interest in contributing to Veyra!

---

## Local Development Setup

### Prerequisites
- Node.js 20+
- Foundry (`forge` / `cast` for smart contract testing)
- Git

### Setup Steps
```bash
# 1. Clone the repository
git clone https://github.com/mioku50/Veyra.git
cd Veyra

# 2. Install dependencies
npm install

# 3. Configure local environment
cp .env.example .env.local

# 4. Start local development server
npm run dev
```

---

## Branch Workflow

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. Keep changes focused and atomic.
3. Verify that all tests pass locally before opening a pull request.

---

## Testing & Verification

Before submitting a pull request, run the non-secret verification suite:

```bash
# Lint code
npm run lint

# Compile and check SDK
npm run machine:sdk-build

# Core deterministic test suites
npm run erc8004:test
npm run erc8183:test
npm run reputation:test
npm run trust-gate:test
npm run counterparty:test
npm run project-360:test
npm run monitoring:test

# Smart contract tests
cd contracts && forge test && cd ..

# Next.js build
npm run build
```

---

## Security & Secrets Policy

- **NEVER commit secrets**: Do not commit `.env`, `.env.local`, API keys, private keys, wallet mnemonics, or bearer tokens.
- **Pull Requests**: Pull requests containing hardcoded credentials or secret material will be rejected immediately.

---

## Proposing Changes

1. Open a GitHub Issue for major feature discussions.
2. Submit a clean Pull Request with a clear description of the problem solved and test results.
3. Ensure CI passes on all checks.
