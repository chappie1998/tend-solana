// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {TendSeriesFactory} from "./TendSeriesFactory.sol";

contract TendSeriesFactoryTest is Test {
    TendSeriesFactory internal factory;
    MockPyth internal pyth;

    address internal owner = address(this);
    address internal emergencyAdmin = address(0xE33);
    address internal settlementToken = address(0xC01A);
    bytes32 internal feedId = bytes32(uint256(0xFEED));

    uint32 internal constant OBS_WINDOW = 60;
    uint32 internal constant GRACE = 3_600;
    uint16 internal constant MAX_CONF_BPS = 2_000;

    function setUp() public {
        pyth = new MockPyth(60, 1 wei);
        factory = new TendSeriesFactory(owner, emergencyAdmin, pyth);
    }

    function _params(uint64 expiry) internal view returns (TendSeriesFactory.CreateSeriesParams memory) {
        return TendSeriesFactory.CreateSeriesParams({
            pythFeedId: feedId,
            settlementToken: settlementToken,
            expiry: expiry,
            observationWindow: OBS_WINDOW,
            settlementGrace: GRACE,
            maxConfidenceBps: MAX_CONF_BPS,
            symbol: bytes32("TEST-EXPIRY")
        });
    }

    function _defaultParams() internal view returns (TendSeriesFactory.CreateSeriesParams memory) {
        return _params(uint64(block.timestamp + 16 minutes));
    }

    // -- creation ---------------------------------------------------------

    function test_AnyoneCanCreateASeries() public {
        address randomCreator = address(0xBEEF);
        vm.prank(randomCreator);
        bytes32 seriesId = factory.createSeries(_defaultParams());

        TendSeriesFactory.Series memory series = factory.getSeries(seriesId);
        assertEq(series.creator, randomCreator);
        assertTrue(series.enabled);
    }

    function test_DuplicateParamsResolveToSameIdAndRevert() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 firstId = factory.createSeries(params);
        bytes32 derived = factory.deriveSeriesId(params);
        assertEq(firstId, derived);

        vm.expectRevert(TendSeriesFactory.SeriesAlreadyExists.selector);
        factory.createSeries(params);
    }

    function test_SeriesIdBindsAllCanonicalParams() public view {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 expected = keccak256(
            abi.encode(
                "TENDMKT1",
                params.pythFeedId,
                params.settlementToken,
                params.expiry,
                params.observationWindow,
                params.settlementGrace,
                params.maxConfidenceBps,
                params.symbol
            )
        );
        assertEq(factory.deriveSeriesId(params), expected);

        TendSeriesFactory.CreateSeriesParams memory changed = params;
        changed.expiry = params.expiry + 1;
        assertNotEq(factory.deriveSeriesId(changed), expected);
        changed = params;
        changed.maxConfidenceBps = params.maxConfidenceBps - 1;
        assertNotEq(factory.deriveSeriesId(changed), expected);
        changed = params;
        changed.symbol = bytes32("OTHER");
        assertNotEq(factory.deriveSeriesId(changed), expected);
    }

    function test_RejectsExpiryBelowLeadTime() public {
        TendSeriesFactory.CreateSeriesParams memory params = _params(uint64(block.timestamp + 1 minutes));
        vm.expectRevert(TendSeriesFactory.InvalidExpiry.selector);
        factory.createSeries(params);
    }

    function test_RejectsObservationWindowOutOfBounds() public {
        TendSeriesFactory.CreateSeriesParams memory tooSmall = _defaultParams();
        tooSmall.observationWindow = 0;
        vm.expectRevert(TendSeriesFactory.InvalidObservationWindow.selector);
        factory.createSeries(tooSmall);

        TendSeriesFactory.CreateSeriesParams memory tooBig = _defaultParams();
        tooBig.observationWindow = uint32(1 hours) + 1;
        vm.expectRevert(TendSeriesFactory.InvalidObservationWindow.selector);
        factory.createSeries(tooBig);
    }

    function test_RejectsSettlementGraceOutOfBounds() public {
        TendSeriesFactory.CreateSeriesParams memory tooSmall = _defaultParams();
        tooSmall.settlementGrace = 0;
        vm.expectRevert(TendSeriesFactory.InvalidSettlementGrace.selector);
        factory.createSeries(tooSmall);

        TendSeriesFactory.CreateSeriesParams memory tooBig = _defaultParams();
        tooBig.settlementGrace = uint32(24 hours) + 1;
        vm.expectRevert(TendSeriesFactory.InvalidSettlementGrace.selector);
        factory.createSeries(tooBig);
    }

    function test_RejectsConfidenceOutOfBounds() public {
        TendSeriesFactory.CreateSeriesParams memory zero = _defaultParams();
        zero.maxConfidenceBps = 0;
        vm.expectRevert(TendSeriesFactory.InvalidConfidence.selector);
        factory.createSeries(zero);

        TendSeriesFactory.CreateSeriesParams memory tooBig = _defaultParams();
        tooBig.maxConfidenceBps = 2_001;
        vm.expectRevert(TendSeriesFactory.InvalidConfidence.selector);
        factory.createSeries(tooBig);
    }

    function test_RejectsCreationWhilePaused() public {
        factory.setPaused(true);
        vm.expectRevert(TendSeriesFactory.Paused.selector);
        factory.createSeries(_defaultParams());
    }

    // -- guardian -----------------------------------------------------------

    function test_OwnerCanDisableSeries_BlocksTradabilityOnly() public {
        bytes32 seriesId = factory.createSeries(_defaultParams());
        assertTrue(factory.isTradable(seriesId));

        factory.setSeriesEnabled(seriesId, false);
        assertFalse(factory.isTradable(seriesId));

        // Guardian disable never blocks refund eligibility computation.
        assertFalse(factory.isRefundable(seriesId));
    }

    function test_NonOwnerCannotDisableSeries() public {
        bytes32 seriesId = factory.createSeries(_defaultParams());
        vm.prank(address(0xBAD));
        vm.expectRevert(TendSeriesFactory.NotOwner.selector);
        factory.setSeriesEnabled(seriesId, false);
    }

    function test_NonPauseAuthorityCannotPause() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(TendSeriesFactory.NotPauseAuthority.selector);
        factory.setPaused(true);
    }

    function test_EmergencyAdminCanPause() public {
        vm.prank(emergencyAdmin);
        factory.setPaused(true);
        assertTrue(factory.paused());
    }

    // -- settlement ---------------------------------------------------------

    function _updateData(uint64 publishTime, int64 price, uint64 conf, int32 expo)
        internal
        view
        returns (bytes[] memory data)
    {
        data = new bytes[](1);
        data[0] = pyth.createPriceFeedUpdateData(feedId, price, conf, expo, price, conf, publishTime, 0);
    }

    function test_PublishSettlement_Succeeds() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);

        vm.warp(params.expiry);
        bytes[] memory data = _updateData(params.expiry, 20_405_953, 10_209, -5);
        uint256 fee = pyth.getUpdateFee(data);

        vm.deal(address(this), 1 ether);
        factory.publishSettlement{value: fee}(seriesId, data);

        TendSeriesFactory.Settlement memory settlement = factory.getSettlement(seriesId);
        assertTrue(settlement.finalized);
        assertEq(settlement.price, 20_405_953 * 1e8 / 1e5);
        assertEq(settlement.publishTime, params.expiry);
    }

    function test_PublishSettlement_RevertsBeforeExpiry() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);

        bytes[] memory data = _updateData(params.expiry, 20_405_953, 10_209, -5);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(TendSeriesFactory.SeriesNotExpired.selector);
        factory.publishSettlement{value: fee}(seriesId, data);
    }

    function test_PublishSettlement_RevertsAfterGraceWindow() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);

        vm.warp(params.expiry + params.observationWindow + params.settlementGrace + 1);
        bytes[] memory data = _updateData(params.expiry, 20_405_953, 10_209, -5);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(TendSeriesFactory.SettlementWindowClosed.selector);
        factory.publishSettlement{value: fee}(seriesId, data);
    }

    function test_PublishSettlement_RevertsOnWideConfidence() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);

        vm.warp(params.expiry);
        // conf * 10000 > price * maxConfidenceBps(2000): pick conf close to price.
        bytes[] memory data = _updateData(params.expiry, 100_000, 50_000, -5);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(TendSeriesFactory.OracleConfidenceTooWide.selector);
        factory.publishSettlement{value: fee}(seriesId, data);
    }

    function test_PublishSettlement_OnlyOnce() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);

        vm.warp(params.expiry);
        bytes[] memory data = _updateData(params.expiry, 20_405_953, 10_209, -5);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(address(this), 1 ether);
        factory.publishSettlement{value: fee}(seriesId, data);

        vm.expectRevert(TendSeriesFactory.AlreadyFinalized.selector);
        factory.publishSettlement{value: fee}(seriesId, data);
    }

    function test_PublishSettlement_IsPermissionlessForAnyCaller() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);

        vm.warp(params.expiry);
        bytes[] memory data = _updateData(params.expiry, 20_405_953, 10_209, -5);
        uint256 fee = pyth.getUpdateFee(data);

        address rando = address(0xC0FFEE);
        vm.deal(rando, 1 ether);
        vm.prank(rando);
        factory.publishSettlement{value: fee}(seriesId, data);

        assertTrue(factory.getSettlement(seriesId).finalized);
    }

    function test_PublishSettlement_EvenWhilePaused() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);
        factory.setPaused(true);

        vm.warp(params.expiry);
        bytes[] memory data = _updateData(params.expiry, 20_405_953, 10_209, -5);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(address(this), 1 ether);
        factory.publishSettlement{value: fee}(seriesId, data);

        assertTrue(factory.getSettlement(seriesId).finalized);
    }

    // -- refund timing --------------------------------------------------------

    function test_IsRefundable_FalseBeforeDeadline_TrueAfter_FalseOnceFinalized() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);

        assertFalse(factory.isRefundable(seriesId));

        uint256 deadline = uint256(params.expiry) + params.observationWindow + params.settlementGrace;
        vm.warp(deadline);
        assertFalse(factory.isRefundable(seriesId));

        vm.warp(deadline + 1);
        assertTrue(factory.isRefundable(seriesId));

        // Finalizing right at the deadline boundary should make it non-refundable.
        vm.warp(deadline);
        bytes[] memory data = _updateData(params.expiry, 20_405_953, 10_209, -5);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(address(this), 1 ether);
        factory.publishSettlement{value: fee}(seriesId, data);

        vm.warp(deadline + 1);
        assertFalse(factory.isRefundable(seriesId));
    }
}
