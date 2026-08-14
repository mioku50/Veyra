# Security Policy

## Supported Versions

| Version | Supported | Notes |
| :--- | :---: | :--- |
| `0.1.0-beta.*` | :white_check_mark: | Current Public Beta on Arc Testnet |
| `< 0.1.0` | :x: | Internal development milestones (unsupported) |

---

## Experimental Software & Testnet Status

- **Arc Testnet Only**: Veyra is currently deployed on **Arc Testnet** (Chain ID `5042002`).
- **Unaudited Smart Contracts**: Smart contracts (including `VeyraTrustGate.sol`, `VeyraERC8183Evaluator.sol`, and `AgentCommerceProofRegistry.sol`) are experimental and have not been independently audited.
- **Do Not Use Real Funds**: Never use production private keys or real financial assets on Arc Testnet.
- **Never Submit Secrets**: When submitting workflow inputs or bug reports, never include private keys, seed phrases, bearer tokens, or sensitive credentials.

---

## Reporting a Vulnerability

We take the security of our platform seriously and appreciate responsible disclosure.

If you discover a security vulnerability or exploit in Veyra:

1. **Do NOT open a public GitHub issue or pull request.**
2. **Submit a Private Vulnerability Report**: Use [GitHub Security Advisories](https://github.com/mioku50/Veyra/security/advisories/new) on the repository.
3. **Include Relevant Details**:
   - Description of the vulnerability and attack vector.
   - Minimal reproduction steps or proof of concept.
   - Potential impact on users, contracts, or agent wallets.
4. **Response Timeline**: We aim to acknowledge receipt of vulnerability reports within 48 hours and provide remediation updates.

Thank you for helping keep the agentic commerce ecosystem safe.