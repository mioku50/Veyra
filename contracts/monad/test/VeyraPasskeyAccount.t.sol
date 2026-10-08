// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.25;

import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VeyraTrustGate} from "veyra/VeyraTrustGate.sol";
import {VeyraPasskeyAccount} from "veyra/monad/VeyraPasskeyAccount.sol";
import {VeyraPasskeyAccountFactory} from "veyra/monad/VeyraPasskeyAccountFactory.sol";

interface VmMetropolis {
    function addr(uint256) external pure returns (address);
    function sign(uint256, bytes32) external pure returns (uint8, bytes32, bytes32);
    function chainId(uint256) external;
    function warp(uint256) external;
    function prank(address) external;
    function etch(address, bytes calldata) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function readFile(string calldata) external view returns (string memory);
    function parseJsonBytes32(string calldata, string calldata) external pure returns (bytes32);
    function parseJsonBytes(string calldata, string calldata) external pure returns (bytes memory);
}

contract TestUsdc {
    mapping(address => uint256) public balanceOf;
    bool public fail;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function setFail(bool value) external { fail = value; }
    function transfer(address to, uint256 amount) external returns (bool) {
        if (fail) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract VeyraPasskeyAccountTest {
    VmMetropolis constant vm = VmMetropolis(address(uint160(uint256(keccak256("hevm cheat code")))));
    // Synthetic unit-test signer, never a live wallet.
    uint256 constant ATTESTER_TEST_KEY = 0xB0B;
    uint64 constant START = 1_800_000_000;
    uint64 constant DEADLINE = START + 120;
    address constant ACCOUNT = address(0xF001);
    address constant GATE = address(0xF002);
    address constant TOKEN = address(0xF003);
    address constant SELLER = address(0x222);
    VeyraPasskeyAccount account;
    VeyraTrustGate gate;
    TestUsdc token;
    VeyraTrustGate.TrustClearance clearance;
    string fixtures;

    function setUp() public {
        vm.chainId(10143);
        vm.warp(START);
        fixtures = vm.readFile("test/fixtures/webauthn.json");
        gate = VeyraTrustGate(GATE);
        _seedGateRoles();
        TestUsdc deployedToken = new TestUsdc();
        vm.etch(TOKEN, address(deployedToken).code);
        token = TestUsdc(TOKEN);
        VeyraPasskeyAccount deployedAccount = new VeyraPasskeyAccount(
            gate, IERC20(TOKEN), vm.parseJsonBytes32(fixtures,".qx"), vm.parseJsonBytes32(fixtures,".qy"),
            sha256(bytes("metropolis.example.test")), "https://metropolis.example.test"
        );
        AccountOriginSetup originSetup = new AccountOriginSetup(
            gate,IERC20(TOKEN),deployedAccount.qx(),deployedAccount.qy(),deployedAccount.rpIdHash(),deployedAccount.origin()
        );
        vm.etch(ACCOUNT,address(originSetup).code);
        AccountOriginSetup(ACCOUNT).initializeTestOrigin(deployedAccount.origin());
        vm.etch(ACCOUNT,address(deployedAccount).code);
        account = VeyraPasskeyAccount(ACCOUNT);
        token.mint(ACCOUNT,1_000_000);
        clearance = VeyraTrustGate.TrustClearance({
            decisionId:keccak256("metropolis-test-decision"), subject:SELLER, executor:ACCOUNT, counterparty:SELLER,
            actionHash:account.paymentActionHash(SELLER,12_000), requestedAmount:12_000, maxAmount:20_000,
            snapshotHash:keccak256("metropolis-test-snapshot"), policyVersion:keccak256("metropolis-test-policy"),
            evaluator:address(0), issuedAt:START, expiresAt:START+300
        });
        assert(account.approvalChallenge(clearance,0,DEADLINE) == vm.parseJsonBytes32(fixtures,".challenge"));
    }

    function _seedGateRoles() internal {
        // Seed test state, then restore the unmodified production TrustGate bytecode.
        GateRoleSetup helper = new GateRoleSetup();
        vm.etch(GATE,address(helper).code);
        GateRoleSetup(GATE).initializeTestRoles(address(this),vm.addr(ATTESTER_TEST_KEY));
        VeyraTrustGate implementation = new VeyraTrustGate(address(this),vm.addr(ATTESTER_TEST_KEY));
        vm.etch(GATE,address(implementation).code);
    }

    function _auth(string memory name) internal view returns (WebAuthn.WebAuthnAuth memory) {
        return abi.decode(vm.parseJsonBytes(fixtures,string.concat(".variants.",name)),(WebAuthn.WebAuthnAuth));
    }
    function _signature() internal view returns (bytes memory) {
        (uint8 v,bytes32 r,bytes32 s) = vm.sign(ATTESTER_TEST_KEY,gate.hashClearance(clearance));
        return abi.encodePacked(r,s,v);
    }
    function _execute(string memory variant) internal { account.executePayment(clearance,_signature(),0,DEADLINE,_auth(variant)); }
    function _assertUnchanged() internal view {
        assert(account.nonce() == 0);
        assert(!gate.consumedClearances(gate.hashClearance(clearance)));
        assert(token.balanceOf(ACCOUNT) == 1_000_000);
        assert(token.balanceOf(SELLER) == 0);
    }
    function _rejected(string memory variant) internal {
        bytes memory sig = _signature();
        WebAuthn.WebAuthnAuth memory auth = _auth(variant);
        vm.expectRevert(); account.executePayment(clearance,sig,0,DEADLINE,auth); _assertUnchanged();
    }

    function testValidNativeWebAuthnPayment() public {
        bytes memory sig = _signature();
        WebAuthn.WebAuthnAuth memory auth = _auth("valid");
        vm.prank(address(0xDEAD));
        account.executePayment(clearance,sig,0,DEADLINE,auth);
        assert(account.nonce() == 1);
        assert(gate.consumedClearances(gate.hashClearance(clearance)));
        assert(token.balanceOf(SELLER) == 12_000);
        assert(token.balanceOf(ACCOUNT) == 988_000);
    }
    function testSyncedPasskeyWithZeroCounter() public { _execute("synced"); assert(account.nonce() == 1); }
    function testNoUserPresence() public { _rejected("noUP"); }
    function testNoUserVerification() public { _rejected("noUV"); }
    function testInvalidBackupFlags() public { _rejected("invalidBackup"); }
    function testWrongPublicKey() public { _rejected("wrongKey"); }
    function testWrongOrigin() public { _rejected("wrongOrigin"); }
    function testWrongRpId() public { _rejected("wrongRpId"); }
    function testWrongType() public { _rejected("wrongType"); }
    function testWrongChallengeIndices() public {
        WebAuthn.WebAuthnAuth memory auth = _auth("valid"); auth.challengeIndex++;
        bytes memory sig = _signature();
        vm.expectRevert(); account.executePayment(clearance,sig,0,DEADLINE,auth); _assertUnchanged();
    }
    function testHighSRejected() public {
        WebAuthn.WebAuthnAuth memory auth = _auth("valid");
        auth.s = bytes32(uint256(0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551) - uint256(auth.s));
        bytes memory sig = _signature();
        vm.expectRevert(); account.executePayment(clearance,sig,0,DEADLINE,auth); _assertUnchanged();
    }
    function testAlteredAmountWithFreshPolicySignatureStillNeedsNewPasskey() public {
        clearance.requestedAmount = 19_000;
        clearance.actionHash = account.paymentActionHash(SELLER,19_000);
        _rejected("valid");
    }
    function testAmountOverLimit() public { clearance.requestedAmount = 21_000; _rejected("valid"); }
    function testAlteredRecipient() public {
        clearance.counterparty = address(0x333);
        clearance.actionHash = account.paymentActionHash(address(0x333),12_000);
        _rejected("valid");
    }
    function testAlteredTokenOrCallDataHash() public { clearance.actionHash = keccak256("approve-or-other-token"); _rejected("valid"); }
    function testZeroPayment() public { clearance.requestedAmount = 0; _rejected("valid"); }
    function testZeroRecipient() public { clearance.counterparty = address(0); _rejected("valid"); }
    function testWrongExecutor() public { clearance.executor = address(0xBAD); _rejected("valid"); }
    function testUnsupportedEvaluatorPath() public { clearance.evaluator = address(0x333); _rejected("valid"); }
    function testFutureIssuance() public { clearance.issuedAt = START+1; _rejected("valid"); }
    function testExpiredPasskeyApproval() public { vm.warp(DEADLINE+1); _rejected("valid"); }
    function testExpiredClearance() public { vm.warp(START+301); _rejected("valid"); }
    function testApprovalDeadlineBeyondClearance() public {
        bytes memory sig = _signature();
        WebAuthn.WebAuthnAuth memory auth = _auth("valid");
        vm.expectRevert(); account.executePayment(clearance,sig,0,START+301,auth); _assertUnchanged();
    }
    function testWrongNonce() public {
        bytes memory sig = _signature();
        WebAuthn.WebAuthnAuth memory auth = _auth("valid");
        vm.expectRevert(); account.executePayment(clearance,sig,1,DEADLINE,auth); _assertUnchanged();
    }
    function testNonceReplay() public {
        bytes memory sig = _signature();
        WebAuthn.WebAuthnAuth memory auth = _auth("valid");
        _execute("valid"); vm.expectRevert(); account.executePayment(clearance,sig,0,DEADLINE,auth);
        assert(token.balanceOf(SELLER) == 12_000);
    }
    function testClearanceReplayWithNewNonceAndValidPasskey() public {
        _execute("valid");
        bytes memory sig = _signature();
        WebAuthn.WebAuthnAuth memory auth = _auth("nextNonce");
        bytes32 digest = gate.hashClearance(clearance);
        vm.expectRevert(abi.encodeWithSelector(VeyraTrustGate.ClearanceAlreadyConsumed.selector,digest));
        account.executePayment(clearance,sig,1,DEADLINE,auth);
        assert(account.nonce() == 1); assert(token.balanceOf(SELLER) == 12_000);
    }
    function testWrongChain() public { vm.chainId(143); _rejected("valid"); }
    function testWrongAttester() public {
        (uint8 v,bytes32 r,bytes32 s) = vm.sign(0xBAD,gate.hashClearance(clearance));
        WebAuthn.WebAuthnAuth memory auth = _auth("valid");
        vm.expectRevert(abi.encodeWithSelector(VeyraTrustGate.UnauthorizedAttester.selector,vm.addr(0xBAD)));
        account.executePayment(clearance,abi.encodePacked(r,s,v),0,DEADLINE,auth); _assertUnchanged();
    }
    function testRevokedAttester() public { gate.setAttester(vm.addr(ATTESTER_TEST_KEY),false); _rejected("valid"); }
    function testTransferFailureRollsBackClearanceAndNonce() public { token.setFail(true); _rejected("valid"); }
    function testOtherAccountCannotReuseAssertion() public {
        VeyraPasskeyAccount other = new VeyraPasskeyAccount(gate,IERC20(TOKEN),account.qx(),account.qy(),account.rpIdHash(),account.origin());
        clearance.executor = address(other);
        bytes memory sig = _signature();
        WebAuthn.WebAuthnAuth memory auth = _auth("valid");
        vm.expectRevert(); other.executePayment(clearance,sig,0,DEADLINE,auth); _assertUnchanged();
    }
    function testFactoryPredictsSeparateAccountsAndIsIdempotent() public {
        VeyraPasskeyAccountFactory factory = new VeyraPasskeyAccountFactory(gate,IERC20(TOKEN),account.rpIdHash(),account.origin());
        address predicted = factory.accountAddress(account.qx(),account.qy(),bytes32(uint256(1)));
        VeyraPasskeyAccount first = factory.createAccount(account.qx(),account.qy(),bytes32(uint256(1)));
        assert(address(first) == predicted);
        assert(address(factory.createAccount(account.qx(),account.qy(),bytes32(uint256(1)))) == predicted);
        assert(address(factory.createAccount(account.qx(),account.qy(),bytes32(uint256(2)))) != predicted);
        assert(address(first.trustGate()) == GATE);
        assert(address(first.usdc()) == TOKEN);
    }
    function testInvalidPublicKeyRejected() public {
        bytes32 rp = account.rpIdHash();
        string memory allowedOrigin = account.origin();
        vm.expectRevert(VeyraPasskeyAccount.InvalidConfiguration.selector);
        new VeyraPasskeyAccount(gate,IERC20(TOKEN),bytes32(0),bytes32(0),rp,allowedOrigin);
    }

    /// @dev Real backend builder and cryptographic signatures, synthetic evidence/token state.
    function _loadBackendFixture() internal returns (bytes memory sig, WebAuthn.WebAuthnAuth memory auth, bytes32 digest) {
        string memory fixture = vm.readFile("test/fixtures/backend-clearance.json");
        clearance = abi.decode(vm.parseJsonBytes(fixture,".encodedClearance"),(VeyraTrustGate.TrustClearance));
        auth = abi.decode(vm.parseJsonBytes(fixture,".assertion"),(WebAuthn.WebAuthnAuth));
        sig = vm.parseJsonBytes(fixture,".signature");
        digest = vm.parseJsonBytes32(fixture,".digest");
        address usdc = 0x534b2f3A21130d7a60830c2Df862319e593943A3;
        TestUsdc mockToken = new TestUsdc();
        vm.etch(usdc,address(mockToken).code);
        token = TestUsdc(usdc);
        string memory allowedOrigin = "https://agent-commerce-six.vercel.app";
        VeyraPasskeyAccount deployed = new VeyraPasskeyAccount(gate,IERC20(usdc),
            vm.parseJsonBytes32(fixture,".qx"),vm.parseJsonBytes32(fixture,".qy"),
            sha256(bytes("agent-commerce-six.vercel.app")),allowedOrigin);
        AccountOriginSetup setup = new AccountOriginSetup(gate,IERC20(usdc),deployed.qx(),deployed.qy(),deployed.rpIdHash(),allowedOrigin);
        vm.etch(ACCOUNT,address(setup).code);
        AccountOriginSetup(ACCOUNT).initializeTestOrigin(allowedOrigin);
        vm.etch(ACCOUNT,address(deployed).code);
        account = VeyraPasskeyAccount(ACCOUNT);
        token.mint(ACCOUNT,1_000_000);
        assert(gate.hashClearance(clearance) == digest);
        assert(account.approvalChallenge(clearance,0,DEADLINE) == vm.parseJsonBytes32(fixture,".challenge"));
        assert(account.paymentActionHash(SELLER,12_000) == clearance.actionHash);
    }

    function testBackendClearancePassesNativeWebAuthnAndTransfersExactAmount() public {
        (bytes memory sig,WebAuthn.WebAuthnAuth memory auth,bytes32 digest) = _loadBackendFixture();
        vm.prank(address(0xDEAD));
        account.executePayment(clearance,sig,0,DEADLINE,auth);
        assert(account.nonce() == 1); assert(gate.consumedClearances(digest));
        assert(token.balanceOf(SELLER) == 12_000); assert(token.balanceOf(ACCOUNT) == 988_000);
    }

    function testBackendClearanceCannotReplay() public {
        (bytes memory sig,WebAuthn.WebAuthnAuth memory auth,) = _loadBackendFixture();
        account.executePayment(clearance,sig,0,DEADLINE,auth);
        vm.expectRevert(VeyraPasskeyAccount.InvalidNonce.selector);
        account.executePayment(clearance,sig,0,DEADLINE,auth);
        assert(token.balanceOf(SELLER) == 12_000);
    }

    function testBackendAmountTamperingFailsWithoutConsumingClearance() public {
        (bytes memory sig,WebAuthn.WebAuthnAuth memory auth,bytes32 digest) = _loadBackendFixture();
        clearance.requestedAmount = 12_001;
        vm.expectRevert(VeyraPasskeyAccount.InvalidAction.selector);
        account.executePayment(clearance,sig,0,DEADLINE,auth);
        assert(!gate.consumedClearances(digest)); assert(account.nonce() == 0);
        assert(token.balanceOf(ACCOUNT) == 1_000_000);
    }

    function testBackendTrustSignatureTamperingFailsAfterValidPasskey() public {
        (,WebAuthn.WebAuthnAuth memory auth,bytes32 digest) = _loadBackendFixture();
        (uint8 v,bytes32 r,bytes32 s) = vm.sign(0xBAD,digest);
        vm.expectRevert(abi.encodeWithSelector(VeyraTrustGate.UnauthorizedAttester.selector,vm.addr(0xBAD)));
        account.executePayment(clearance,abi.encodePacked(r,s,v),0,DEADLINE,auth);
        assert(!gate.consumedClearances(digest)); assert(account.nonce() == 0);
    }
}

/// @dev Local setup helper, never used as the implementation under test or deployed to a network.
contract GateRoleSetup is VeyraTrustGate {
    constructor() VeyraTrustGate(address(this),address(this)) {}
    function initializeTestRoles(address admin,address attester) external {
        _grantRole(DEFAULT_ADMIN_ROLE,admin);
        _grantRole(TRUST_ATTESTER_ROLE,attester);
    }
}

contract AccountOriginSetup is VeyraPasskeyAccount {
    constructor(VeyraTrustGate gate_,IERC20 usdc_,bytes32 qx_,bytes32 qy_,bytes32 rp_,string memory origin_)
        VeyraPasskeyAccount(gate_,usdc_,qx_,qy_,rp_,origin_) {}
    function initializeTestOrigin(string memory origin_) external { origin = origin_; }
}
