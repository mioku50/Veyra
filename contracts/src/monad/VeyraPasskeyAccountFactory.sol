// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.25;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VeyraTrustGate} from "../VeyraTrustGate.sol";
import {VeyraPasskeyAccount} from "./VeyraPasskeyAccount.sol";

/// @notice Deterministic accounts; deploying the same public credential cannot change its owner.
contract VeyraPasskeyAccountFactory {
    VeyraTrustGate public immutable trustGate;
    IERC20 public immutable usdc;
    bytes32 public immutable rpIdHash;
    string public origin;

    event AccountCreated(address indexed account, bytes32 indexed salt, bytes32 qx, bytes32 qy);

    constructor(VeyraTrustGate gate_, IERC20 usdc_, bytes32 rpIdHash_, string memory origin_) {
        if (address(gate_).code.length == 0 || address(usdc_).code.length == 0 || rpIdHash_ == 0 || bytes(origin_).length == 0) {
            revert VeyraPasskeyAccount.InvalidConfiguration();
        }
        trustGate = gate_;
        usdc = usdc_;
        rpIdHash = rpIdHash_;
        origin = origin_;
    }

    function accountAddress(bytes32 qx, bytes32 qy, bytes32 userSalt) public view returns (address) {
        bytes memory initCode = abi.encodePacked(
            type(VeyraPasskeyAccount).creationCode,
            abi.encode(trustGate, usdc, qx, qy, rpIdHash, origin)
        );
        return Create2.computeAddress(keccak256(abi.encode(qx, qy, userSalt)), keccak256(initCode));
    }

    function createAccount(bytes32 qx, bytes32 qy, bytes32 userSalt) external returns (VeyraPasskeyAccount account) {
        address predicted = accountAddress(qx, qy, userSalt);
        if (predicted.code.length > 0) return VeyraPasskeyAccount(predicted);
        bytes32 salt = keccak256(abi.encode(qx, qy, userSalt));
        account = new VeyraPasskeyAccount{salt: salt}(trustGate, usdc, qx, qy, rpIdHash, origin);
        emit AccountCreated(address(account), salt, qx, qy);
    }
}
