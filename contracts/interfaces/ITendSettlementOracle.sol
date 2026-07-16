// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ITendSettlementOracle {
    /// @notice Returns an expiry-window settlement value with 8 decimals.
    function settlementPrice(address underlying, uint64 expiry)
        external
        view
        returns (uint256 price, uint64 observedAt, bool finalized);
}
