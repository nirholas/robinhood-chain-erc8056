// SPDX-License-Identifier: LicenseRef-Proprietary
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {ERC8056} from "../contracts/ERC8056.sol";
import {ERC8056StockToken} from "../contracts/ERC8056StockToken.sol";
import {IERC8056, IERC8056Scheduled} from "../contracts/IERC8056.sol";

/**
 * @dev A plain ERC-20 with no ERC-8056 surface at all: the "pre-8056 token" case.
 *      Used to prove that `uiMultiplier()` reverts rather than returning garbage on
 *      a token that predates the standard, which is the exact condition the
 *      TypeScript `readUiMultiplier` fallback is built around.
 */
contract PreERC8056Token is ERC20 {
    constructor() ERC20("Legacy Equity Token", "LEGACY") {
        _mint(msg.sender, 1_000e18);
    }
}

contract ERC8056Test is Test {
    uint256 internal constant WAD = 1e18;

    ERC8056StockToken internal token;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        // Start well past the epoch so `block.timestamp - 1` is a valid past timestamp.
        vm.warp(1_800_000_000);

        vm.prank(admin);
        token = new ERC8056StockToken("Apple Stock Token", "AAPL", "https://issuer.example/terms", admin);

        vm.startPrank(admin);
        token.mint(alice, 100e18);
        token.mint(bob, 3e18);
        vm.stopPrank();
    }

    // -----------------------------------------------------------------
    // Baseline
    // -----------------------------------------------------------------

    function test_StartsAtOneToOne() public view {
        assertEq(token.uiMultiplier(), WAD, "fresh token must be 1:1");
        assertEq(token.balanceOfUI(alice), 100e18, "share equivalent equals balance at 1:1");
        assertEq(token.totalSupplyUI(), token.totalSupply(), "supply views agree at 1:1");
        assertEq(token.effectiveAt(), 0, "nothing scheduled");
        assertEq(token.newUIMultiplier(), WAD, "pending view reports current when idle");
    }

    function test_ConstructorEmitsInitialMultiplier() public {
        vm.expectEmit(true, true, true, true);
        emit IERC8056.UIMultiplierUpdated(0, WAD, block.timestamp);
        new ERC8056StockToken("Nvidia Stock Token", "NVDA", "https://issuer.example/terms", admin);
    }

    function test_TermsIsReadable() public view {
        assertEq(token.terms(), "https://issuer.example/terms");
    }

    // -----------------------------------------------------------------
    // Forward split
    // -----------------------------------------------------------------

    function test_ForwardSplit_MovesSharesNotBalances() public {
        uint256 aliceBalanceBefore = token.balanceOf(alice);
        uint256 supplyBefore = token.totalSupply();

        vm.prank(admin);
        token.applySplit(4, 1);

        assertEq(token.uiMultiplier(), 4 * WAD, "4:1 split sets multiplier to 4.0");

        // The load-bearing assertion of the whole standard.
        assertEq(token.balanceOf(alice), aliceBalanceBefore, "balances MUST NOT move on a split");
        assertEq(token.totalSupply(), supplyBefore, "supply MUST NOT move on a split");

        assertEq(token.balanceOfUI(alice), 400e18, "100 tokens now represent 400 shares");
        assertEq(token.balanceOfUI(bob), 12e18, "3 tokens now represent 12 shares");
        assertEq(token.totalSupplyUI(), supplyBefore * 4, "share supply quadruples");
    }

    function test_ForwardSplit_EmitsUpdateAndNoTransfer() public {
        vm.recordLogs();

        vm.prank(admin);
        vm.expectEmit(true, true, true, true);
        emit IERC8056.UIMultiplierUpdated(WAD, 4 * WAD, block.timestamp);
        token.applySplit(4, 1);

        // A corporate action must be invisible to a Transfer-only indexer.
        bytes32 transferTopic = keccak256("Transfer(address,address,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != transferTopic, "a split must not emit Transfer");
        }
    }

    function test_TransfersAreUnaffectedByASplit() public {
        vm.prank(admin);
        token.applySplit(4, 1);

        vm.prank(alice);
        token.transfer(bob, 10e18);

        assertEq(token.balanceOf(alice), 90e18, "transfer moves exactly the token amount requested");
        assertEq(token.balanceOf(bob), 13e18);
        assertEq(token.balanceOfUI(alice), 360e18, "share view follows the new balance");
        assertEq(token.balanceOfUI(bob), 52e18);
    }

    // -----------------------------------------------------------------
    // Reverse split
    // -----------------------------------------------------------------

    function test_ReverseSplit() public {
        vm.prank(admin);
        token.applySplit(1, 10);

        assertEq(token.uiMultiplier(), WAD / 10, "1:10 reverse split sets multiplier to 0.1");
        assertEq(token.balanceOf(alice), 100e18, "balances still do not move");
        assertEq(token.balanceOfUI(alice), 10e18, "100 tokens now represent 10 shares");
        assertEq(token.balanceOfUI(bob), 0.3e18);
    }

    function test_ReverseSplitThenForwardSplitRoundTrips() public {
        vm.startPrank(admin);
        token.applySplit(1, 10);
        token.applySplit(10, 1);
        vm.stopPrank();

        assertEq(token.uiMultiplier(), WAD, "1:10 then 10:1 returns exactly to 1.0");
        assertEq(token.balanceOfUI(alice), 100e18);
    }

    function test_ComposedRatiosTruncate_DocumentedBehaviour() public {
        // 1e18 / 3 truncates to 333333333333333333, and *3 lands one wei short.
        vm.startPrank(admin);
        token.applySplit(1, 3);
        assertEq(token.uiMultiplier(), 333_333_333_333_333_333, "division truncates toward zero");
        token.applySplit(3, 1);
        vm.stopPrank();

        assertEq(token.uiMultiplier(), WAD - 1, "composed ratios are not exactly associative");
    }

    // -----------------------------------------------------------------
    // Fractional multipliers (reinvested dividends)
    // -----------------------------------------------------------------

    function test_FractionalMultiplier_ReinvestedDividend() public {
        // A 0.37% reinvested dividend.
        vm.prank(admin);
        token.applySplit(10_037, 10_000);

        assertEq(token.uiMultiplier(), 1.0037e18, "multiplier picks up the dividend");
        assertEq(token.balanceOfUI(alice), 100.37e18, "100 tokens represent 100.37 shares");
        assertEq(token.balanceOf(alice), 100e18, "and the balance is untouched");
    }

    function test_FractionalMultiplier_ExactValueSetter() public {
        vm.prank(admin);
        token.setUIMultiplier(1_234_567_890_123_456_789);

        assertEq(token.uiMultiplier(), 1_234_567_890_123_456_789);
        // 3e18 * 1234567890123456789 / 1e18, truncated.
        assertEq(token.balanceOfUI(bob), 3_703_703_670_370_370_367);
    }

    // -----------------------------------------------------------------
    // Rounding direction
    // -----------------------------------------------------------------

    function test_RoundingIsAlwaysTowardZero() public {
        vm.prank(admin);
        token.setUIMultiplier(WAD / 3); // 333333333333333333

        // 1 wei of token * 0.333... = 0.333... wei of share, which truncates to 0.
        vm.prank(admin);
        token.mint(stranger, 1);
        assertEq(token.balanceOfUI(stranger), 0, "sub-unit share equivalents truncate to zero, never round up");

        // 4 wei * 333333333333333333 / 1e18 = 1.333... -> 1
        vm.prank(admin);
        token.mint(stranger, 3);
        assertEq(token.balanceOf(stranger), 4);
        assertEq(token.balanceOfUI(stranger), 1, "truncates rather than rounding to nearest");
    }

    function test_SumOfShareBalancesNeverExceedsShareSupply() public {
        // The solvency reason truncation is mandatory: with round-half-up, three
        // holders each holding a rounding-up remainder would collectively appear to
        // own more shares than exist.
        vm.prank(admin);
        token.setUIMultiplier(WAD / 3);

        vm.startPrank(admin);
        token.burn(alice, token.balanceOf(alice));
        token.burn(bob, token.balanceOf(bob));
        token.mint(alice, 2);
        token.mint(bob, 2);
        token.mint(stranger, 2);
        vm.stopPrank();

        uint256 summed = token.balanceOfUI(alice) + token.balanceOfUI(bob) + token.balanceOfUI(stranger);
        assertLe(summed, token.totalSupplyUI(), "share balances must never over-sum the share supply");
    }

    function testFuzz_ShareBalanceNeverExceedsShareSupply(uint128 balance, uint96 multiplier) public {
        vm.assume(multiplier > 0);

        vm.prank(admin);
        token.setUIMultiplier(uint256(multiplier));

        vm.prank(admin);
        token.mint(stranger, balance);

        assertLe(token.balanceOfUI(stranger), token.totalSupplyUI(), "holder shares bounded by supply shares");
    }

    function testFuzz_TokensToSharesRoundTripNeverInflates(uint128 amount, uint96 multiplier) public {
        vm.assume(multiplier > 0);

        vm.prank(admin);
        token.setUIMultiplier(uint256(multiplier));

        uint256 shares = token.tokensToShares(amount);
        uint256 back = token.sharesToTokens(shares);
        assertLe(back, amount, "a shares round trip must never manufacture tokens");
    }

    // -----------------------------------------------------------------
    // Large multipliers and overflow behaviour
    // -----------------------------------------------------------------

    function test_HugeMultiplierUsesFullWidthIntermediate() public {
        // uint256 tops out just above 1.15e77. At the maximum multiplier (1e36), a
        // balance of 1e50 makes the naive intermediate product 1e50 * 1e36 = 1e86,
        // which overflows, while the true result 1e86 / 1e18 = 1e68 fits with room
        // to spare. This is precisely the case Math.mulDiv's 512-bit intermediate
        // exists to handle, and the reason the reference implementation does not
        // write `(balance * multiplier) / WAD`.
        uint256 max = maxMultiplier();

        vm.prank(admin);
        token.setUIMultiplier(max);

        vm.prank(admin);
        token.mint(stranger, 1e50);

        assertEq(token.balanceOfUI(stranger), 1e68, "mulDiv survives an intermediate product above 2^256");
    }

    function maxMultiplier() internal view returns (uint256) {
        return token.MAX_UI_MULTIPLIER();
    }

    function test_RejectsMultiplierAboveMax() public {
        uint256 tooBig = maxMultiplier() + 1;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ERC8056.ERC8056MultiplierTooLarge.selector, tooBig));
        token.setUIMultiplier(tooBig);
    }

    function test_RejectsZeroMultiplier() public {
        vm.prank(admin);
        vm.expectRevert(ERC8056.ERC8056ZeroMultiplier.selector);
        token.setUIMultiplier(0);
    }

    function test_RejectsZeroRatio() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(ERC8056.ERC8056InvalidRatio.selector, uint256(0), uint256(1)));
        token.applySplit(0, 1);

        vm.expectRevert(abi.encodeWithSelector(ERC8056.ERC8056InvalidRatio.selector, uint256(1), uint256(0)));
        token.applySplit(1, 0);
        vm.stopPrank();
    }

    function test_RejectsSplitThatTruncatesToZero() public {
        vm.startPrank(admin);
        // 1e18 / 1e19 truncates to 0, which the zero guard must catch.
        vm.expectRevert(ERC8056.ERC8056ZeroMultiplier.selector);
        token.applySplit(1, 1e19);
        vm.stopPrank();
    }

    // -----------------------------------------------------------------
    // Scheduling
    // -----------------------------------------------------------------

    function test_ScheduledSplitDoesNotApplyEarly() public {
        uint256 when = block.timestamp + 3 days;

        vm.prank(admin);
        token.scheduleSplit(4, 1, when);

        assertEq(token.uiMultiplier(), WAD, "still 1:1 before the effective time");
        assertEq(token.balanceOfUI(alice), 100e18);
        assertEq(token.newUIMultiplier(), 4 * WAD, "the pending value is readable in advance");
        assertEq(token.effectiveAt(), when);

        vm.warp(when - 1);
        assertEq(token.uiMultiplier(), WAD, "one second before, still unapplied");

        vm.warp(when);
        assertEq(token.uiMultiplier(), 4 * WAD, "applies at the effective second, with no transaction");
        assertEq(token.balanceOfUI(alice), 400e18);
    }

    function test_SyncMultiplierIsIdempotentAndValuePreserving() public {
        uint256 when = block.timestamp + 1 days;

        vm.prank(admin);
        token.scheduleSplit(4, 1, when);
        vm.warp(when);

        uint256 before = token.uiMultiplier();
        token.syncMultiplier(); // permissionless
        assertEq(token.uiMultiplier(), before, "sync cannot change the observed value");
        assertEq(token.effectiveAt(), 0, "pending slot cleared");
        assertEq(token.newUIMultiplier(), before);

        token.syncMultiplier();
        assertEq(token.uiMultiplier(), before, "sync is idempotent");
    }

    function test_ReschedulingReplacesAnUnmaturedAction() public {
        uint256 when = block.timestamp + 5 days;

        vm.startPrank(admin);
        token.scheduleSplit(4, 1, when);
        token.scheduleSplit(2, 1, when); // corrected announcement
        vm.stopPrank();

        assertEq(token.newUIMultiplier(), 2 * WAD, "the corrected ratio replaced the original");

        vm.warp(when);
        assertEq(token.uiMultiplier(), 2 * WAD);
    }

    function test_ReschedulingCannotDiscardAMaturedAction() public {
        uint256 first = block.timestamp + 1 days;

        vm.prank(admin);
        token.scheduleSplit(4, 1, first);

        vm.warp(first);
        assertEq(token.uiMultiplier(), 4 * WAD, "first action matured");

        // A second announcement must compose onto the matured 4.0, not replace it.
        uint256 second = block.timestamp + 1 days;
        vm.prank(admin);
        token.scheduleSplit(2, 1, second);

        assertEq(token.uiMultiplier(), 4 * WAD, "matured action retained while the next is pending");
        assertEq(token.newUIMultiplier(), 8 * WAD, "the new ratio composes onto it");

        vm.warp(second);
        assertEq(token.uiMultiplier(), 8 * WAD);
    }

    function test_RejectsEffectiveTimeInThePast() public {
        uint256 past = block.timestamp - 1;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ERC8056.ERC8056EffectiveInPast.selector, past, block.timestamp));
        token.scheduleUIMultiplier(2 * WAD, past);
    }

    // -----------------------------------------------------------------
    // Authorization
    // -----------------------------------------------------------------

    function test_StrangerCannotRunACorporateAction() public {
        vm.startPrank(stranger);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, token.CORPORATE_ACTION_ROLE()
            )
        );
        token.applySplit(4, 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, token.CORPORATE_ACTION_ROLE()
            )
        );
        token.setUIMultiplier(2 * WAD);

        vm.stopPrank();

        assertEq(token.uiMultiplier(), WAD, "no partial write from a denied action");
    }

    function test_IssuerRoleIsSeparateFromCorporateActionRole() public {
        address issuerOnly = makeAddr("issuerOnly");
        bytes32 issuerRole = token.ISSUER_ROLE();
        bytes32 corporateActionRole = token.CORPORATE_ACTION_ROLE();

        vm.prank(admin);
        token.grantRole(issuerRole, issuerOnly);

        vm.prank(issuerOnly);
        token.mint(alice, 1e18); // allowed

        vm.prank(issuerOnly);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, issuerOnly, corporateActionRole
            )
        );
        token.applySplit(4, 1);
    }

    function test_StrangerMayCallSyncMultiplier() public {
        vm.prank(admin);
        token.scheduleSplit(4, 1, block.timestamp + 1 days);
        vm.warp(block.timestamp + 1 days);

        vm.prank(stranger);
        token.syncMultiplier(); // permissionless by design, no revert

        assertEq(token.uiMultiplier(), 4 * WAD);
    }

    // -----------------------------------------------------------------
    // Conversions
    // -----------------------------------------------------------------

    function test_ConversionsUnderASplit() public {
        vm.prank(admin);
        token.applySplit(4, 1);

        assertEq(token.tokensToShares(25e18), 100e18, "25 tokens are 100 shares after a 4:1 split");
        assertEq(token.sharesToTokens(100e18), 25e18, "100 shares are 25 tokens");
    }

    // -----------------------------------------------------------------
    // ERC-165 and the pre-8056 case
    // -----------------------------------------------------------------

    function test_SupportsInterface() public view {
        assertTrue(token.supportsInterface(type(IERC8056).interfaceId), "declares IERC8056");
        assertTrue(token.supportsInterface(type(IERC8056Scheduled).interfaceId), "declares IERC8056Scheduled");
        assertFalse(token.supportsInterface(0xdeadbeef), "rejects an unknown id");
    }

    function test_PreERC8056Token_RevertsOnUiMultiplier() public {
        PreERC8056Token legacy = new PreERC8056Token();

        (bool ok, bytes memory ret) = address(legacy).staticcall(abi.encodeWithSignature("uiMultiplier()"));

        // This is the exact on-chain condition the `erc8056` TypeScript package's
        // "a revert means 1e18" fallback exists to absorb. A pre-8056 token has no
        // such function, so the call fails with empty returndata rather than
        // yielding a wrong number.
        assertFalse(ok, "a pre-8056 token has no uiMultiplier()");
        assertEq(ret.length, 0, "and returns no data to misinterpret");

        // The plain ERC-20 surface still works, which is why treating the revert as
        // 1e18 is safe: balances already are share equivalents on such a token.
        assertEq(legacy.balanceOf(address(this)), 1_000e18);
    }
}
