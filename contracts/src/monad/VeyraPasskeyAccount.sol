// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {VeyraTrustGate} from "../VeyraTrustGate.sol";

/// @notice Testnet prototype: human-approved exact USDC transfers, never generic execution.
/// @dev Key recovery and rotation are intentionally outside this prototype's scope.
contract VeyraPasskeyAccount is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant DEMO_CHAIN_ID = 10143;
    bytes32 public constant APPROVAL_TYPEHASH = keccak256(
        "VeyraPasskeyPayment(uint256 chainId,address account,address trustGate,bytes32 clearanceDigest,bytes32 actionHash,uint256 nonce,uint64 deadline)"
    );

    VeyraTrustGate public immutable trustGate;
    IERC20 public immutable usdc;
    bytes32 public immutable qx;
    bytes32 public immutable qy;
    bytes32 public immutable rpIdHash;
    string public origin;
    uint256 public nonce;

    error InvalidConfiguration();
    error WrongChain();
    error InvalidPayment();
    error InvalidAction();
    error InvalidNonce();
    error InvalidDeadline();
    error InvalidAssertion();

    event PaymentExecuted(bytes32 indexed clearanceDigest, address indexed counterparty, uint256 amount, uint256 nonce);

    constructor(VeyraTrustGate gate_, IERC20 usdc_, bytes32 qx_, bytes32 qy_, bytes32 rpIdHash_, string memory origin_) {
        if (
            address(gate_).code.length == 0 || address(usdc_).code.length == 0 ||
            !P256.isValidPublicKey(qx_, qy_) || rpIdHash_ == bytes32(0) || bytes(origin_).length == 0
        ) revert InvalidConfiguration();
        trustGate = gate_;
        usdc = usdc_;
        qx = qx_;
        qy = qy_;
        rpIdHash = rpIdHash_;
        origin = origin_;
    }

    function paymentActionHash(address counterparty, uint256 amount) public view returns (bytes32) {
        return keccak256(abi.encode(address(usdc), uint256(0), abi.encodeCall(IERC20.transfer, (counterparty, amount))));
    }

    function approvalChallenge(VeyraTrustGate.TrustClearance calldata clearance, uint256 approvalNonce, uint64 deadline)
        public view returns (bytes32)
    {
        return keccak256(abi.encode(
            APPROVAL_TYPEHASH, block.chainid, address(this), address(trustGate),
            trustGate.hashClearance(clearance), clearance.actionHash, approvalNonce, deadline
        ));
    }

    /// @dev Permissionless relay: both signatures, not msg.sender, authorize the payment.
    function executePayment(
        VeyraTrustGate.TrustClearance calldata clearance,
        bytes calldata veyraSignature,
        uint256 approvalNonce,
        uint64 deadline,
        WebAuthn.WebAuthnAuth calldata assertion
    ) external nonReentrant {
        if (block.chainid != DEMO_CHAIN_ID) revert WrongChain();
        if (approvalNonce != nonce) revert InvalidNonce();
        if (
            deadline < block.timestamp || deadline > clearance.expiresAt ||
            clearance.issuedAt > block.timestamp || clearance.issuedAt > deadline
        ) revert InvalidDeadline();
        if (
            clearance.executor != address(this) || clearance.counterparty == address(0) ||
            clearance.counterparty == address(this) || clearance.requestedAmount == 0 ||
            clearance.evaluator != address(0) ||
            clearance.requestedAmount > clearance.maxAmount
        ) revert InvalidPayment();
        if (clearance.actionHash != paymentActionHash(clearance.counterparty, clearance.requestedAmount)) {
            revert InvalidAction();
        }

        bytes32 challenge = approvalChallenge(clearance, approvalNonce, deadline);
        // Compare the complete browser encoding: no nested/duplicate fields or untrusted indices.
        bytes memory expectedJSON = abi.encodePacked(
            '{"type":"webauthn.get","challenge":"', Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"', origin, '","crossOrigin":false}'
        );
        if (
            assertion.authenticatorData.length < 37 ||
            bytes32(assertion.authenticatorData[:32]) != rpIdHash ||
            keccak256(bytes(assertion.clientDataJSON)) != keccak256(expectedJSON)
        ) revert InvalidAssertion();

        bytes32 signedHash = sha256(abi.encodePacked(assertion.authenticatorData, sha256(bytes(assertion.clientDataJSON))));
        // Require the native path: successful Solidity fallback verification is insufficient.
        if (!P256.verifyNative(signedHash, assertion.r, assertion.s, qx, qy)) revert InvalidAssertion();
        if (!WebAuthn.verify(abi.encodePacked(challenge), assertion, qx, qy, true)) revert InvalidAssertion();

        bytes32 digest = trustGate.hashClearance(clearance);
        nonce = approvalNonce + 1;
        trustGate.consumeClearance(clearance, veyraSignature);
        usdc.safeTransfer(clearance.counterparty, clearance.requestedAmount);
        emit PaymentExecuted(digest, clearance.counterparty, clearance.requestedAmount, approvalNonce);
    }
}
