// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.25;

import {VeyraTrustGate} from "../src/VeyraTrustGate.sol";

interface Vm {
    function expectEmit(bool, bool, bool, bool) external;
    function expectEmit(bool, bool, bool, bool, address) external;
    function expectRevert(bytes calldata) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
    function prank(address) external;
    function warp(uint256) external;
    function addr(uint256) external pure returns (address);
    function sign(uint256, bytes32) external pure returns (uint8 v, bytes32 r, bytes32 s);
}

contract VeyraTrustGateTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    VeyraTrustGate public gate;

    uint256 public adminPrivateKey = 0xA11CE;
    address public admin;

    uint256 public attesterPrivateKey = 0xB0B;
    address public attester;

    uint256 public wrongPrivateKey = 0xBAD;
    address public wrongSigner;

    VeyraTrustGate.TrustClearance public clearance;

    event TrustClearanceConsumed(
        bytes32 indexed clearanceDigest,
        address indexed subject,
        address indexed counterparty,
        bytes32 decisionId,
        bytes32 actionHash,
        uint256 amount,
        bytes32 reputationSnapshotHash
    );

    function setUp() public {
        vm.warp(1_800_000_000);
        admin = vm.addr(adminPrivateKey);
        attester = vm.addr(attesterPrivateKey);
        wrongSigner = vm.addr(wrongPrivateKey);

        gate = new VeyraTrustGate(admin, attester);

        clearance = VeyraTrustGate.TrustClearance({
            decisionId: keccak256("dec_123"),
            subject: address(0x111),
            executor: address(0x444),
            counterparty: address(0x222),
            actionHash: keccak256("action_123"),
            requestedAmount: 100_000_000,
            maxAmount: 200_000_000,
            snapshotHash: keccak256("snap_123"),
            policyVersion: keccak256("pol_1"),
            evaluator: address(0x333),
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 300)
        });
    }

    function testVerifyClearanceValid() public {
        bytes32 digest = gate.hashClearance(clearance);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        (bool valid, address signer) = gate.verifyClearance(clearance, sig);
        assert(valid);
        assert(signer == attester);
        assert(gate.isClearanceValid(clearance, sig));
    }

    function testVerifyClearanceExpired() public {
        bytes32 digest = gate.hashClearance(clearance);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.warp(block.timestamp + 301); // past expiresAt

        (bool valid, ) = gate.verifyClearance(clearance, sig);
        assert(!valid);
    }

    function testVerifyClearanceWrongSigner() public {
        bytes32 digest = gate.hashClearance(clearance);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        (bool valid, address signer) = gate.verifyClearance(clearance, sig);
        assert(!valid);
        assert(signer == wrongSigner);
    }

    function testConsumeClearance() public {
        bytes32 digest = gate.hashClearance(clearance);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.expectEmit(true, true, true, true, address(gate));
        emit TrustClearanceConsumed(
            digest,
            clearance.subject,
            clearance.counterparty,
            clearance.decisionId,
            clearance.actionHash,
            clearance.requestedAmount,
            clearance.snapshotHash
        );

        vm.prank(clearance.executor);
        gate.consumeClearance(clearance, sig);

        assert(gate.consumedClearances(digest));

        (bool valid, ) = gate.verifyClearance(clearance, sig);
        assert(!valid); // Already consumed
    }

    function testConsumeClearanceReplay() public {
        bytes32 digest = gate.hashClearance(clearance);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(clearance.executor);
        gate.consumeClearance(clearance, sig);

        vm.expectRevert(abi.encodeWithSelector(VeyraTrustGate.ClearanceAlreadyConsumed.selector, digest));
        vm.prank(clearance.executor);
        gate.consumeClearance(clearance, sig);
    }

    function testConsumeClearanceExpired() public {
        bytes32 digest = gate.hashClearance(clearance);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.warp(block.timestamp + 301);

        vm.expectRevert(abi.encodeWithSelector(VeyraTrustGate.ClearanceExpired.selector, clearance.expiresAt, uint64(block.timestamp)));
        vm.prank(clearance.executor);
        gate.consumeClearance(clearance, sig);
    }

    function testConsumeClearanceAmountExceedsMax() public {
        clearance.requestedAmount = 300_000_000;
        
        bytes32 digest = gate.hashClearance(clearance);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.expectRevert(abi.encodeWithSelector(VeyraTrustGate.AmountExceedsMax.selector, 300_000_000, 200_000_000));
        vm.prank(clearance.executor);
        gate.consumeClearance(clearance, sig);
    }

    function testSetAttester() public {
        vm.prank(admin);
        gate.setAttester(address(0x444), true);

        vm.prank(admin);
        gate.setAttester(address(0x444), false);
    }
    
    function testConsumeInvalidHash() public {
        clearance.decisionId = bytes32(0);
        bytes32 digest = gate.hashClearance(clearance);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.expectRevert(VeyraTrustGate.InvalidHash.selector);
        vm.prank(clearance.executor);
        gate.consumeClearance(clearance, sig);
    }

    function testAttackerCannotConsumeVictimClearance() public {
        bytes32 digest = gate.hashClearance(clearance);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        address attacker = address(0xDEAD);

        vm.expectRevert(
            abi.encodeWithSelector(
                VeyraTrustGate.UnauthorizedExecutor.selector,
                attacker,
                clearance.executor
            )
        );
        vm.prank(attacker);
        gate.consumeClearance(clearance, sig);
        assert(!gate.consumedClearances(digest));
    }
}
