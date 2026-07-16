// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TendMarket} from "./TendMarket.sol";
import {ITendEligibility} from "./interfaces/ITendEligibility.sol";

contract TendMarketTest {
    TendMarket internal market;

    function setUp() public {
        market = new TendMarket(address(this), address(this), ITendEligibility(address(0)));
    }

    function test_UpPayoutIsZeroBelowStrike() public view {
        require(market.payoutAt(TendMarket.Direction.Up, 99e8, 100e8, 120e8, 1_000e6) == 0);
    }

    function test_UpPayoutIsLinearAndCapped() public view {
        require(market.payoutAt(TendMarket.Direction.Up, 110e8, 100e8, 120e8, 1_000e6) == 500e6);
        require(market.payoutAt(TendMarket.Direction.Up, 200e8, 100e8, 120e8, 1_000e6) == 1_000e6);
    }

    function test_DownPayoutIsZeroAboveStrike() public view {
        require(market.payoutAt(TendMarket.Direction.Down, 101e8, 100e8, 80e8, 1_000e6) == 0);
    }

    function test_DownPayoutIsLinearAndCapped() public view {
        require(market.payoutAt(TendMarket.Direction.Down, 90e8, 100e8, 80e8, 1_000e6) == 500e6);
        require(market.payoutAt(TendMarket.Direction.Down, 20e8, 100e8, 80e8, 1_000e6) == 1_000e6);
    }

    function testFuzz_PayoutNeverExceedsCollateral(uint128 rawPrice, uint96 rawPayout) public view {
        uint256 price = uint256(rawPrice) % 300e8;
        uint256 maxPayout = uint256(rawPayout) + 1;
        uint256 upPayout = market.payoutAt(TendMarket.Direction.Up, price, 100e8, 120e8, maxPayout);
        uint256 downPayout = market.payoutAt(TendMarket.Direction.Down, price, 100e8, 80e8, maxPayout);
        require(upPayout <= maxPayout, "up payout exceeds collateral");
        require(downPayout <= maxPayout, "down payout exceeds collateral");
    }
}
