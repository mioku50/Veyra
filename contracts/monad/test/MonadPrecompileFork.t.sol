// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.25;
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

interface VmMonadFork {
    function activeFork() external view returns (uint256);
    function readFile(string calldata) external view returns (string memory);
    function parseJsonBytes32(string calldata,string calldata) external pure returns (bytes32);
    function parseJsonBytes(string calldata,string calldata) external pure returns (bytes memory);
}
interface MonadRegistry { function getIdentityRegistry() external view returns (address); }
interface MonadUsdc { function decimals() external view returns (uint8); }

/// @dev Run explicitly with a pinned Monad Testnet fork; never mocks address 0x0100.
contract MonadPrecompileForkTest {
    VmMonadFork constant vm = VmMonadFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    function testForkCanonicalContractsAndNativeWebAuthn() public view {
        vm.activeFork(); // fails if accidentally run without a fork
        assert(block.chainid == 10143);
        assert(MonadUsdc(0x534b2f3A21130d7a60830c2Df862319e593943A3).decimals() == 6);
        assert(MonadRegistry(0x8004B663056A597Dffe9eCcC1965A193B7388713).getIdentityRegistry() == 0x8004A818BFB912233c491871b3d84c89A494BD9e);
        string memory fixtures = vm.readFile("test/fixtures/webauthn.json");
        WebAuthn.WebAuthnAuth memory auth = abi.decode(vm.parseJsonBytes(fixtures,".variants.valid"),(WebAuthn.WebAuthnAuth));
        bytes32 qx = vm.parseJsonBytes32(fixtures,".qx");
        bytes32 qy = vm.parseJsonBytes32(fixtures,".qy");
        bytes32 signedHash = vm.parseJsonBytes32(fixtures,".signedHash");
        assert(P256.verifyNative(signedHash,auth.r,auth.s,qx,qy));
        assert(!P256.verifyNative(bytes32(uint256(signedHash)^1),auth.r,auth.s,qx,qy));
        assert(WebAuthn.verify(abi.encodePacked(vm.parseJsonBytes32(fixtures,".challenge")),auth,qx,qy,true));
    }
}
