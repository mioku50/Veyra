// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.25;

import {VeyraTrustGate} from "../src/VeyraTrustGate.sol";

interface Vm {
    function envAddress(string calldata name) external returns (address value);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Deploy with an encrypted Foundry keystore account; never pass a key on the CLI.
contract DeployVeyraTrustGate {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (VeyraTrustGate gate) {
        address operator = vm.envAddress("TRUST_GATE_ADMIN_ADDRESS");
        address attester = vm.envAddress("TRUST_GATE_ATTESTER_ADDRESS");

        vm.startBroadcast();
        gate = new VeyraTrustGate(operator, attester);
        vm.stopBroadcast();
    }
}
