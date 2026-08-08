// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.25;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

contract VeyraTrustGate is EIP712, AccessControl {
    bytes32 public constant TRUST_ATTESTER_ROLE = keccak256("TRUST_ATTESTER_ROLE");

    bytes32 public constant CLEARANCE_TYPEHASH = keccak256(
        "TrustClearance(bytes32 decisionId,address subject,address executor,address counterparty,bytes32 actionHash,uint256 requestedAmount,uint256 maxAmount,bytes32 snapshotHash,bytes32 policyVersion,address evaluator,uint64 issuedAt,uint64 expiresAt)"
    );

    struct TrustClearance {
        bytes32 decisionId;
        address subject;
        address executor;
        address counterparty;
        bytes32 actionHash;
        uint256 requestedAmount;
        uint256 maxAmount;
        bytes32 snapshotHash;
        bytes32 policyVersion;
        address evaluator;
        uint64 issuedAt;
        uint64 expiresAt;
    }

    mapping(bytes32 => bool) public consumedClearances;

    event TrustClearanceConsumed(
        bytes32 indexed decisionHash,
        address indexed subject,
        address indexed counterparty,
        bytes32 actionHash,
        uint256 amount,
        bytes32 reputationSnapshotHash
    );

    error ClearanceExpired(uint64 expiresAt, uint64 currentTimestamp);
    error ClearanceAlreadyConsumed(bytes32 decisionHash);
    error UnauthorizedAttester(address signer);
    error UnauthorizedExecutor(address caller, address executor);
    error ZeroAddress();
    error InvalidHash();
    error AmountExceedsMax(uint256 requested, uint256 max);

    constructor(
        address initialAdmin,
        address initialAttester
    ) EIP712("Veyra Trust Gate", "1") {
        if (initialAdmin == address(0) || initialAttester == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(TRUST_ATTESTER_ROLE, initialAttester);
    }

    function hashClearance(TrustClearance calldata clearance) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                CLEARANCE_TYPEHASH,
                clearance.decisionId,
                clearance.subject,
                clearance.executor,
                clearance.counterparty,
                clearance.actionHash,
                clearance.requestedAmount,
                clearance.maxAmount,
                clearance.snapshotHash,
                clearance.policyVersion,
                clearance.evaluator,
                clearance.issuedAt,
                clearance.expiresAt
            )
        );
        return _hashTypedDataV4(structHash);
    }

    function verifyClearance(
        TrustClearance calldata clearance,
        bytes calldata signature
    ) public view returns (bool valid, address signer) {
        if (
            clearance.decisionId == bytes32(0) ||
            clearance.snapshotHash == bytes32(0) ||
            clearance.subject == address(0) ||
            clearance.executor == address(0)
        ) return (false, address(0));
        if (clearance.expiresAt < block.timestamp) return (false, address(0));
        if (clearance.requestedAmount > clearance.maxAmount) return (false, address(0));

        bytes32 digest = hashClearance(clearance);
        signer = ECDSA.recover(digest, signature);
        valid = hasRole(TRUST_ATTESTER_ROLE, signer) && !consumedClearances[digest];
    }

    function isClearanceValid(
        TrustClearance calldata clearance,
        bytes calldata signature
    ) external view returns (bool) {
        (bool valid, ) = verifyClearance(clearance, signature);
        return valid;
    }

    function consumeClearance(
        TrustClearance calldata clearance,
        bytes calldata signature
    ) external {
        if (
            clearance.decisionId == bytes32(0) ||
            clearance.snapshotHash == bytes32(0) ||
            clearance.subject == address(0) ||
            clearance.executor == address(0)
        ) revert InvalidHash();
        if (msg.sender != clearance.executor) {
            revert UnauthorizedExecutor(msg.sender, clearance.executor);
        }
        if (clearance.expiresAt < block.timestamp) {
            revert ClearanceExpired(clearance.expiresAt, uint64(block.timestamp));
        }
        if (clearance.requestedAmount > clearance.maxAmount) {
            revert AmountExceedsMax(clearance.requestedAmount, clearance.maxAmount);
        }

        bytes32 digest = hashClearance(clearance);
        if (consumedClearances[digest]) revert ClearanceAlreadyConsumed(digest);

        address signer = ECDSA.recover(digest, signature);
        if (!hasRole(TRUST_ATTESTER_ROLE, signer)) revert UnauthorizedAttester(signer);

        consumedClearances[digest] = true;

        emit TrustClearanceConsumed(
            clearance.decisionId,
            clearance.subject,
            clearance.counterparty,
            clearance.actionHash,
            clearance.requestedAmount,
            clearance.snapshotHash
        );
    }

    function setAttester(address attester, bool active) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (attester == address(0)) revert ZeroAddress();
        if (active) {
            _grantRole(TRUST_ATTESTER_ROLE, attester);
        } else {
            _revokeRole(TRUST_ATTESTER_ROLE, attester);
        }
    }
}
