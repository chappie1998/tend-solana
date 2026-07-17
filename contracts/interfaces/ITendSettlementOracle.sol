// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ITendSettlementOracle {
    /// @notice Returns a finalized post-expiry observation-window value with 8 decimals.
    function settlementPrice(address underlying, uint64 expiry, uint32 observationWindow)
        external
        view
        returns (uint256 price, uint64 observedFrom, uint64 observedTo, bool finalized);
}
