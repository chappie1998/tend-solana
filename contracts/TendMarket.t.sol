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

    function test_IntradayQuoteWindowRequiresTradeLock() public view {
        uint64 expiry = uint64(block.timestamp + 15 minutes);
        require(market.quoteWindowOpen(expiry, uint64(block.timestamp + 30 seconds), 60));
        require(!market.quoteWindowOpen(expiry, expiry - 30 seconds, 60));
        require(!market.quoteWindowOpen(expiry, uint64(block.timestamp + 30 seconds), 10));
    }

    function test_QuoteTupleEncodingMatchesEip712FieldEncoding() public view {
        TendMarket.Quote memory quote = TendMarket.Quote({
            maker: address(0xA11CE),
            buyer: address(0xB0B),
            underlying: address(0x1111),
            collateralToken: address(0x2222),
            oracle: address(0x3333),
            premium: 10e6,
            maxPayout: 100e6,
            strike: 100e8,
            capPrice: 110e8,
            expiry: uint64(block.timestamp + 15 minutes),
            deadline: uint64(block.timestamp + 30 seconds),
            nonce: 7,
            observationWindow: 60,
            tradeLock: 60,
            direction: TendMarket.Direction.Up
        });
        bytes32 structHash = keccak256(abi.encode(
            market.QUOTE_TYPEHASH(),
            quote.maker,
            quote.buyer,
            quote.underlying,
            quote.collateralToken,
            quote.oracle,
            quote.premium,
            quote.maxPayout,
            quote.strike,
            quote.capPrice,
            quote.expiry,
            quote.deadline,
            quote.nonce,
            quote.observationWindow,
            quote.tradeLock,
            quote.direction
        ));
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", market.domainSeparator(), structHash));
        require(market.hashQuote(quote) == expected, "tuple encoding changed quote digest");
    }
}
