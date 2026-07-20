// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {TendSeriesFactory} from "./TendSeriesFactory.sol";
import {TendPoolVault} from "./TendPoolVault.sol";
import {MockERC20} from "./test/MockERC20.sol";

contract TendPoolVaultTest is Test {
    TendSeriesFactory internal factory;
    TendPoolVault internal vault;
    MockPyth internal pyth;
    MockERC20 internal token;

    uint256 internal constant QUOTE_AUTHORITY_PK = 0xA11CE;
    uint256 internal constant WRONG_SIGNER_PK = 0xBAD;
    address internal quoteAuthority;
    address internal lp = address(0x117);
    address internal buyer = address(0xB0B);
    address internal feeRecipient = address(0xFEE);
    address internal emergencyAdmin = address(0xE33);

    bytes32 internal feedId = bytes32(uint256(0xFEED));
    bytes32 internal seriesId;
    uint64 internal expiry;
    uint64 internal lastTradeAt;

    uint32 internal constant OBS_WINDOW = 60;
    uint32 internal constant GRACE = 3_600;
    uint16 internal constant FEE_BPS = 100;

    function setUp() public {
        quoteAuthority = vm.addr(QUOTE_AUTHORITY_PK);
        pyth = new MockPyth(60, 1 wei);
        factory = new TendSeriesFactory(address(this), emergencyAdmin, pyth);
        token = new MockERC20("Mock USD", "mUSD", 6);
        vault = new TendPoolVault(
            address(factory), address(token), quoteAuthority, 8_000, 5_000, FEE_BPS, feeRecipient
        );

        expiry = uint64(block.timestamp + 16 minutes);
        lastTradeAt = expiry - 60;
        seriesId = factory.createSeries(
            TendSeriesFactory.CreateSeriesParams({
                pythFeedId: feedId,
                settlementToken: address(token),
                expiry: expiry,
                observationWindow: OBS_WINDOW,
                settlementGrace: GRACE,
                maxConfidenceBps: 2_000,
                symbol: bytes32("TEST-EXPIRY")
            })
        );
        vault.authorizeSeries(seriesId, true, lastTradeAt);

        token.mint(lp, 1_000_000e6);
        token.mint(buyer, 1_000e6);
        vm.prank(lp);
        token.approve(address(vault), type(uint256).max);
        vm.prank(buyer);
        token.approve(address(vault), type(uint256).max);
    }

    function _deposit(uint256 amount) internal returns (uint256 shares) {
        vm.prank(lp);
        shares = vault.deposit(amount, 0, block.timestamp + 1);
    }

    function _quote(uint256 nonce) internal view returns (TendPoolVault.PoolQuote memory) {
        return TendPoolVault.PoolQuote({
            nonce: nonce,
            direction: uint8(TendPoolVault.Direction.Up),
            strike: 100e8,
            width: 20e8,
            premium: 10e6,
            maxPayout: 1_000e6,
            quoteExpiry: uint64(block.timestamp + 5 minutes),
            seriesId: seriesId,
            buyer: buyer
        });
    }

    function _sign(TendPoolVault.PoolQuote memory quote, uint256 pk) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                vault.POOL_QUOTE_TYPEHASH(),
                quote.nonce,
                quote.direction,
                quote.strike,
                quote.width,
                quote.premium,
                quote.maxPayout,
                quote.quoteExpiry,
                quote.seriesId,
                quote.buyer
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _fill(uint256 nonce) internal returns (uint256 positionId) {
        TendPoolVault.PoolQuote memory quote = _quote(nonce);
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        positionId = vault.fillPoolQuote(quote, signature);
    }

    function _publishSettlement(int64 rawPrice) internal {
        bytes[] memory data = new bytes[](1);
        data[0] = pyth.createPriceFeedUpdateData(feedId, rawPrice, 1_000_000, -8, rawPrice, 1_000_000, expiry, 0);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(address(this), 1 ether);
        factory.publishSettlement{value: fee}(seriesId, data);
    }

    // -- share math: exact Solana unit vectors (math.rs tests) ---------------

    function test_ShareMath_SolanaUnitVectors() public view {
        // First deposit mints 1:1.
        assertEq(vault.calculateDepositShares(1_000, 0, 0), 1_000);
        // Deposit 333 into {shares 1000, assets 3000} -> 111 (rounded down).
        assertEq(vault.calculateDepositShares(333, 1_000, 3_000), 111);
        // Withdraw 111 from {shares 1000, assets 3001} -> 333 (rounded down).
        assertEq(vault.calculateWithdrawAmount(111, 1_000, 3_001), 333);
        // BPS limit vector.
        assertEq(vault.calculateBpsLimit(10_000, 7_500), 7_500);
    }

    function test_ShareMath_InsolventAndDustCasesRevert() public {
        // Deposit into insolvent pool (assets == 0, shares > 0) reverts.
        vm.expectRevert(TendPoolVault.PoolInsolvent.selector);
        vault.calculateDepositShares(1, 1, 0);
        // Dust deposit yielding zero shares reverts (Solana: 1 into {1, u64::MAX}).
        vm.expectRevert(TendPoolVault.DepositTooSmall.selector);
        vault.calculateDepositShares(1, 1, type(uint64).max);
        // Zero amounts revert.
        vm.expectRevert(TendPoolVault.InvalidAmount.selector);
        vault.calculateDepositShares(0, 0, 0);
        vm.expectRevert(TendPoolVault.InvalidAmount.selector);
        vault.calculateWithdrawAmount(0, 1_000, 3_000);
        // Withdraw from empty pool / more shares than exist revert.
        vm.expectRevert(TendPoolVault.InvalidPoolShares.selector);
        vault.calculateWithdrawAmount(1, 0, 0);
        vm.expectRevert(TendPoolVault.InvalidPoolShares.selector);
        vault.calculateWithdrawAmount(1_001, 1_000, 3_000);
        // Dust withdrawal yielding zero assets reverts.
        vm.expectRevert(TendPoolVault.DepositTooSmall.selector);
        vault.calculateWithdrawAmount(1, type(uint64).max, 1);
    }

    function test_FeeRoundsUp() public view {
        // Solana math.rs: calculate_fee(1, 25) == 1, calculate_fee(10_000, 25) == 25.
        assertEq(vault.calculateFee(1, 25), 1);
        assertEq(vault.calculateFee(10_000, 25), 25);
        assertEq(vault.calculateFee(10_000, 0), 0);
        assertEq(vault.calculateFee(0, 25), 0);
    }

    // -- payout math: linear, directional, capped (math.rs vectors + fuzz) ----

    function test_PayoutIsLinearDirectionalAndCapped() public view {
        assertEq(vault.calculatePayout(0, 100, 20, 90, 1_000), 0);
        assertEq(vault.calculatePayout(0, 100, 20, 110, 1_000), 500);
        assertEq(vault.calculatePayout(0, 100, 20, 150, 1_000), 1_000);
        assertEq(vault.calculatePayout(1, 100, 20, 90, 1_000), 500);
        assertEq(vault.calculatePayout(1, 100, 20, 50, 1_000), 1_000);
    }

    function testFuzz_PayoutNeverExceedsCollateral(
        uint8 direction,
        uint128 strike,
        uint128 width,
        uint128 price,
        uint128 maxPayout
    ) public view {
        direction = direction % 2;
        width = uint128(bound(width, 1, type(uint128).max));
        maxPayout = uint128(bound(maxPayout, 1, type(uint128).max));
        uint256 payout = vault.calculatePayout(direction, strike, width, price, maxPayout);
        assertLe(payout, maxPayout, "payout exceeds collateral");
    }

    function testFuzz_SettlementConservesEscrow(
        uint8 direction,
        uint128 strike,
        uint128 width,
        uint128 price,
        uint128 maxPayout,
        uint128 premium,
        uint16 feeBps
    ) public view {
        direction = direction % 2;
        width = uint128(bound(width, 1, type(uint128).max));
        maxPayout = uint128(bound(maxPayout, 1, type(uint128).max));
        premium = uint128(bound(premium, 1, type(uint128).max));
        feeBps = uint16(bound(feeBps, 0, 1_000));

        uint256 payout = vault.calculatePayout(direction, strike, width, price, maxPayout);
        uint256 fee = vault.calculateFee(premium, feeBps);
        uint256 maker = uint256(maxPayout) - payout + premium - fee;
        assertEq(payout + maker + fee, uint256(maxPayout) + premium, "escrow not conserved");
    }

    // -- deposits / withdrawals ------------------------------------------------

    function test_FirstDepositMintsOneToOne() public {
        uint256 shares = _deposit(10_000e6);
        assertEq(shares, 10_000e6);
        assertEq(vault.totalShares(), 10_000e6);
        assertEq(vault.totalAssets(), 10_000e6);
        assertEq(vault.sharesOf(lp), 10_000e6);
        assertEq(token.balanceOf(address(vault)), 10_000e6);
    }

    function test_WithdrawReturnsAssets() public {
        _deposit(10_000e6);
        vm.prank(lp);
        uint256 amount = vault.withdraw(4_000e6, 0, block.timestamp + 1);
        assertEq(amount, 4_000e6);
        assertEq(vault.totalShares(), 6_000e6);
        assertEq(vault.totalAssets(), 6_000e6);
        assertEq(token.balanceOf(lp), 1_000_000e6 - 6_000e6);
    }

    function test_DepositsAndWithdrawalsBlockedWhileObligationsOpen() public {
        _deposit(10_000e6);
        _fill(1);

        vm.prank(lp);
        vm.expectRevert(TendPoolVault.PoolHasOpenPositions.selector);
        vault.deposit(1_000e6, 0, block.timestamp + 1);

        vm.prank(lp);
        vm.expectRevert(TendPoolVault.PoolHasOpenPositions.selector);
        vault.withdraw(1_000e6, 0, block.timestamp + 1);
    }

    function test_LifecycleReopensLiquidityAfterSettlement() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);
        vm.warp(expiry);
        _publishSettlement(110e8);
        vault.settlePoolPosition(positionId);

        // Obligations cleared: LP can withdraw everything that remains.
        assertEq(vault.openPositions(), 0);
        assertEq(vault.lockedCollateral(), 0);
        vm.prank(lp);
        uint256 amount = vault.withdraw(10_000e6, 0, block.timestamp + 1);
        // 9_000e6 free + (1_000e6 - 500e6 payout + 10e6 premium - 0.1e6 fee) returned.
        assertEq(amount, 9_509_900_000);
        assertEq(vault.totalShares(), 0);
        assertEq(vault.totalAssets(), 0);
    }

    // -- fills -------------------------------------------------------------

    function test_FillEscrowsCollateralAndPremium() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);
        assertEq(positionId, 1);

        assertEq(vault.totalAssets(), 9_000e6);
        assertEq(vault.lockedCollateral(), 1_000e6);
        assertEq(vault.escrowedPremium(), 10e6);
        assertEq(vault.openPositions(), 1);
        // Full escrow physically present in the vault.
        assertEq(token.balanceOf(address(vault)), 10_010e6);
        assertEq(token.balanceOf(buyer), 1_000e6 - 10e6);
    }

    function test_ReplayedQuoteRejected() public {
        _deposit(10_000e6);
        TendPoolVault.PoolQuote memory quote = _quote(1);
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vault.fillPoolQuote(quote, signature);

        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.AlreadyFilled.selector);
        vault.fillPoolQuote(quote, signature);
    }

    function test_WrongSignerRejected() public {
        _deposit(10_000e6);
        TendPoolVault.PoolQuote memory quote = _quote(1);
        bytes memory signature = _sign(quote, WRONG_SIGNER_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.BadSignature.selector);
        vault.fillPoolQuote(quote, signature);
    }

    function test_ExpiredQuoteRejected() public {
        _deposit(10_000e6);
        TendPoolVault.PoolQuote memory quote = _quote(1);
        quote.quoteExpiry = uint64(block.timestamp);
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.warp(block.timestamp + 1);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.QuoteExpired.selector);
        vault.fillPoolQuote(quote, signature);
    }

    function test_TamperedQuoteRejected() public {
        _deposit(10_000e6);
        TendPoolVault.PoolQuote memory quote = _quote(1);
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        quote.premium = 1;
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.BadSignature.selector);
        vault.fillPoolQuote(quote, signature);
    }

    function test_OnlyNamedBuyerCanFill() public {
        _deposit(10_000e6);
        TendPoolVault.PoolQuote memory quote = _quote(1);
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.prank(address(0xD00D));
        vm.expectRevert(TendPoolVault.InvalidBuyer.selector);
        vault.fillPoolQuote(quote, signature);
    }

    function test_UtilizationCapEnforced() public {
        _deposit(1_000e6);
        // maxPayout 1_000e6 > 80% of 1_000e6 -> utilization exceeded.
        TendPoolVault.PoolQuote memory quote = _quote(1);
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.PoolUtilizationExceeded.selector);
        vault.fillPoolQuote(quote, signature);
    }

    function test_PerPositionCapEnforced() public {
        _deposit(1_900e6);
        // 80% cap = 1_520e6 passes; 50% per-position cap = 950e6 < 1_000e6 fails.
        TendPoolVault.PoolQuote memory quote = _quote(1);
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.PoolPositionLimitExceeded.selector);
        vault.fillPoolQuote(quote, signature);
    }

    function test_FillRejectedAfterLastTradeCutoff() public {
        _deposit(10_000e6);
        vm.warp(lastTradeAt);
        TendPoolVault.PoolQuote memory quote = _quote(1);
        quote.quoteExpiry = lastTradeAt;
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.LastTradeCutoffReached.selector);
        vault.fillPoolQuote(quote, signature);
    }

    // -- settlement ---------------------------------------------------------

    function test_SettleAgainstPythPrice_ExactEscrowConservation() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);
        vm.warp(expiry);
        _publishSettlement(110e8); // normalized 110e8; strike 100e8, width 20e8 -> half payout

        uint256 buyerBefore = token.balanceOf(buyer);
        uint256 payout = vault.settlePoolPosition(positionId);

        uint256 expectedPayout = 500e6;
        uint256 expectedFee = 100_000; // ceil(10e6 * 100 / 10000)
        uint256 expectedPoolAmount = 1_000e6 - expectedPayout + 10e6 - expectedFee;

        assertEq(payout, expectedPayout);
        assertEq(token.balanceOf(buyer) - buyerBefore, expectedPayout);
        assertEq(token.balanceOf(feeRecipient), expectedFee);
        assertEq(vault.totalAssets(), 9_000e6 + expectedPoolAmount);
        assertEq(vault.lockedCollateral(), 0);
        assertEq(vault.escrowedPremium(), 0);
        assertEq(vault.openPositions(), 0);
        // payout + poolAmount + fee == maxPayout + premium, on real token balances.
        assertEq(expectedPayout + expectedPoolAmount + expectedFee, 1_000e6 + 10e6);
        assertEq(token.balanceOf(address(vault)), vault.totalAssets());
    }

    function test_SettleCappedPayout_BuyerGetsMaxPayout() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);
        vm.warp(expiry);
        _publishSettlement(150e8); // above strike + width -> capped

        uint256 payout = vault.settlePoolPosition(positionId);
        assertEq(payout, 1_000e6);
    }

    function test_SettleOutOfTheMoney_PoolKeepsCollateral() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);
        vm.warp(expiry);
        _publishSettlement(90e8); // below strike -> zero payout

        uint256 payout = vault.settlePoolPosition(positionId);
        assertEq(payout, 0);
        assertEq(vault.totalAssets(), 10_000e6 + 10e6 - 100_000);
    }

    function test_SettleRevertsWithoutFinalizedSettlement() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);
        vm.warp(expiry);
        vm.expectRevert(TendPoolVault.NotFinalized.selector);
        vault.settlePoolPosition(positionId);
    }

    function test_SettleOnlyOnce() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);
        vm.warp(expiry);
        _publishSettlement(110e8);
        vault.settlePoolPosition(positionId);
        vm.expectRevert(TendPoolVault.AlreadySettled.selector);
        vault.settlePoolPosition(positionId);
    }

    // -- timeout refund -----------------------------------------------------

    function test_RefundAfterOracleTimeout() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);

        // Not refundable while the settlement window is open.
        vm.warp(uint256(expiry) + OBS_WINDOW + GRACE);
        vm.expectRevert(TendPoolVault.SettlementWindowOpen.selector);
        vault.refundPoolPosition(positionId);

        vm.warp(uint256(expiry) + OBS_WINDOW + GRACE + 1);
        uint256 buyerBefore = token.balanceOf(buyer);
        // Anyone may trigger the refund.
        vm.prank(address(0xD00D));
        vault.refundPoolPosition(positionId);

        // Buyer gets the premium back; pool gets its collateral back.
        assertEq(token.balanceOf(buyer) - buyerBefore, 10e6);
        assertEq(vault.totalAssets(), 10_000e6);
        assertEq(vault.lockedCollateral(), 0);
        assertEq(vault.openPositions(), 0);
        assertEq(token.balanceOf(address(vault)), 10_000e6);
    }

    function test_RefundOnlyOnce() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);
        vm.warp(uint256(expiry) + OBS_WINDOW + GRACE + 1);
        vault.refundPoolPosition(positionId);
        vm.expectRevert(TendPoolVault.AlreadySettled.selector);
        vault.refundPoolPosition(positionId);
    }

    function test_RefundBlockedOnceSettlementFinalized() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);
        vm.warp(expiry);
        _publishSettlement(110e8);
        vm.warp(uint256(expiry) + OBS_WINDOW + GRACE + 1);
        vm.expectRevert(TendPoolVault.SettlementWindowOpen.selector);
        vault.refundPoolPosition(positionId);
        // Settlement still works after the window closes.
        vault.settlePoolPosition(positionId);
    }

    // -- permissionless creation vs manager-only administration ---------------

    function test_AnyoneCanCreateAPoolAndBecomesManager() public {
        address rando = address(0xF00);
        vm.prank(rando);
        TendPoolVault newVault = new TendPoolVault(
            address(factory), address(token), quoteAuthority, 8_000, 5_000, FEE_BPS, feeRecipient
        );
        assertEq(newVault.manager(), rando);
    }

    function test_NonManagerCannotAuthorizeSeries() public {
        vm.prank(address(0xF00));
        vm.expectRevert(TendPoolVault.NotManager.selector);
        vault.authorizeSeries(seriesId, true, lastTradeAt);
    }

    function test_NonManagerCannotUpdatePool() public {
        vm.prank(address(0xF00));
        vm.expectRevert(TendPoolVault.NotManager.selector);
        vault.updatePool(quoteAuthority, 8_000, 5_000, FEE_BPS, feeRecipient);
    }

    function test_ManagerUpdatesBlockedWhileObligationsOpen() public {
        _deposit(10_000e6);
        _fill(1);
        vm.expectRevert(TendPoolVault.PoolHasOpenPositions.selector);
        vault.updatePool(quoteAuthority, 8_000, 5_000, FEE_BPS, feeRecipient);
        vm.expectRevert(TendPoolVault.PoolHasOpenPositions.selector);
        vault.authorizeSeries(seriesId, false, 0);
    }

    function test_ManagerCanRotateQuoteAuthority_OldQuotesRejected() public {
        _deposit(10_000e6);
        vault.updatePool(vm.addr(WRONG_SIGNER_PK), 8_000, 5_000, FEE_BPS, feeRecipient);

        TendPoolVault.PoolQuote memory quote = _quote(1);
        bytes memory oldAuthoritySig = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.BadSignature.selector);
        vault.fillPoolQuote(quote, oldAuthoritySig);

        bytes memory newAuthoritySig = _sign(quote, WRONG_SIGNER_PK);
        vm.prank(buyer);
        vault.fillPoolQuote(quote, newAuthoritySig);
    }

    function test_InvalidRiskLimitsRejected() public {
        vm.expectRevert(TendPoolVault.InvalidPoolRiskLimits.selector);
        new TendPoolVault(address(factory), address(token), quoteAuthority, 0, 0, FEE_BPS, feeRecipient);
        vm.expectRevert(TendPoolVault.InvalidPoolRiskLimits.selector);
        new TendPoolVault(address(factory), address(token), quoteAuthority, 10_001, 5_000, FEE_BPS, feeRecipient);
        vm.expectRevert(TendPoolVault.InvalidPoolRiskLimits.selector);
        new TendPoolVault(address(factory), address(token), quoteAuthority, 5_000, 8_000, FEE_BPS, feeRecipient);
    }

    // -- manager handover -----------------------------------------------------

    function test_ManagerTransfersAndNewManagerControlsOldManagerLocked() public {
        address newManager = address(0xCAFE3);
        vault.transferManager(newManager);
        assertEq(vault.manager(), newManager);

        vm.prank(newManager);
        vault.updatePool(quoteAuthority, 8_000, 5_000, FEE_BPS, feeRecipient);

        vm.prank(newManager);
        vault.authorizeSeries(seriesId, true, lastTradeAt);

        vm.expectRevert(TendPoolVault.NotManager.selector);
        vault.updatePool(quoteAuthority, 8_000, 5_000, FEE_BPS, feeRecipient);

        vm.expectRevert(TendPoolVault.NotManager.selector);
        vault.authorizeSeries(seriesId, true, lastTradeAt);
    }

    function test_NonManagerCannotTransferManager() public {
        vm.prank(address(0xF00));
        vm.expectRevert(TendPoolVault.NotManager.selector);
        vault.transferManager(address(0xCAFE3));
    }

    function test_TransferManagerToZeroAddressReverts() public {
        vm.expectRevert(TendPoolVault.InvalidAuthority.selector);
        vault.transferManager(address(0));
    }

    function test_TransferManagerBlockedWhileObligationsOpen() public {
        _deposit(10_000e6);
        _fill(1);
        vm.expectRevert(TendPoolVault.PoolHasOpenPositions.selector);
        vault.transferManager(address(0xCAFE3));
    }

    // -- guardian pause: blocks new fills, never settlement/refund -------------

    function test_GuardianPauseBlocksNewFillsButNotSettlement() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);

        factory.setPaused(true);

        TendPoolVault.PoolQuote memory quote = _quote(2);
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.SeriesNotTradable.selector);
        vault.fillPoolQuote(quote, signature);

        // Settlement publication and position settlement still work while paused.
        vm.warp(expiry);
        _publishSettlement(110e8);
        uint256 payout = vault.settlePoolPosition(positionId);
        assertEq(payout, 500e6);
    }

    function test_GuardianDisableBlocksNewFillsButNotRefund() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);

        factory.setSeriesEnabled(seriesId, false);

        TendPoolVault.PoolQuote memory quote = _quote(2);
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.SeriesNotTradable.selector);
        vault.fillPoolQuote(quote, signature);

        // Timeout refund still works on the disabled series.
        vm.warp(uint256(expiry) + OBS_WINDOW + GRACE + 1);
        vault.refundPoolPosition(positionId);
        assertEq(vault.openPositions(), 0);
    }
}
