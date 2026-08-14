# Smart Contracts & Registries

> **Network**: Arc Testnet  
> **Chain ID**: `5042002` (`0x4CEF52`)  
> **RPC URL**: `https://rpc.testnet.arc.network`  
> **Explorer**: [https://testnet.arcscan.app](https://testnet.arcscan.app)  
> **Native Gas Token**: USDC (18 decimals)  

> [!WARNING]
> **Experimental & Unaudited**: All smart contracts listed below are deployed on **Arc Testnet** for testing, evaluation, and public beta demonstration. They have **not** been audited by an independent third party. Do not use real assets or mainnet keys.

---

## Canonical Veyra Protocol Contracts

### 1. Veyra Proof Registry
- **Address**: [`0x92dC1aFC126F755ba5d5254e8D697CAe10474851`](https://testnet.arcscan.app/address/0x92dC1aFC126F755ba5d5254e8D697CAe10474851)
- **Deployment Transaction**: [`0x7efc6fc86e96781030f79f5ef8e2b1169e8a38b8f9d3395b905cee687bef2ab2`](https://testnet.arcscan.app/tx/0x7efc6fc86e96781030f79f5ef8e2b1169e8a38b8f9d3395b905cee687bef2ab2)
- **Source Code**: [`contracts/src/AgentCommerceProofRegistry.sol`](file:///home/mioku/Agent-Commerce/contracts/src/AgentCommerceProofRegistry.sol)
- **Purpose**: Stores immutable cryptographic hashes and metadata for completed workflow executions and evaluation receipts on Arc.

### 2. Veyra Trust Gate
- **Source Code**: [`contracts/src/VeyraTrustGate.sol`](file:///home/mioku/Agent-Commerce/contracts/src/VeyraTrustGate.sol)
- **EIP-712 Domain**: `"Veyra Trust Gate"`, Version `"1"`
- **Purpose**: Validates signed policy clearance tickets prior to high-risk actions, enforcing spending caps, single-use ticket consumption, and replay protection on Arc.

### 3. Veyra ERC-8183 Independent Evaluator
- **Source Code**: [`contracts/src/VeyraERC8183Evaluator.sol`](file:///home/mioku/Agent-Commerce/contracts/src/VeyraERC8183Evaluator.sol)
- **EIP-712 Domain**: `"Veyra ERC8183 Evaluator"`, Version `"1"`
- **Purpose**: Verifies external deliverable hashes against job policy hashes and submits cryptographic verdicts (`Complete` / `Reject`) to authorize ERC-8183 job settlement on Arc.

---

## Arc Ecosystem Standard Registries

### ERC-8004 Agent Identity & Validation
Configured Arc Testnet registry deployments used for agent identity registration and reputation provenance:

| Registry | Address | Arcscan Link |
| :--- | :--- | :--- |
| **ERC-8004 Identity Registry** | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | [Arcscan](https://testnet.arcscan.app/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) |
| **ERC-8004 Reputation Registry** | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | [Arcscan](https://testnet.arcscan.app/address/0x8004B663056A597Dffe9eCcC1965A193B7388713) |
| **ERC-8004 Validation Registry** | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | [Arcscan](https://testnet.arcscan.app/address/0x8004Cb1BF31DAf7788923b405b754f57acEB4272) |

---

## Token Addresses

| Token | Address | Decimals | Standard |
| :--- | :--- | :---: | :--- |
| **USDC** | `0x3600000000000000000000000000000000000000` | 6 | ERC-20 |
| **EURC** | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` | 6 | ERC-20 |
| **Native Gas (USDC)** | N/A (Native) | 18 | Native Layer-1 Gas |

---

## Testing Contracts Locally

```bash
cd contracts
forge test -vvv
```
