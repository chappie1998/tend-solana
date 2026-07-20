// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ITendSeriesFactory
/// @notice Read-only view surface `TendPoolVault` uses to look up series terms
/// and finalized Pyth settlement prices published on `TendSeriesFactory`.
/// @dev Prototype — unaudited.
interface ITendSeriesFactory {
    struct Series {
        address creator;
        bytes32 pythFeedId;
        address settlementToken;
        uint64 expiry;
        uint32 observationWindow;
        uint32 settlementGrace;
        uint16 maxConfidenceBps;
        bytes32 symbol;
        bool enabled;
    }

    struct Settlement {
        bool finalized;
        uint256 price;
        uint64 publishTime;
    }

    /// @notice Returns the series terms. Reverts if the series does not exist.
    function getSeries(bytes32 seriesId) external view returns (Series memory);

    /// @notice True if the series exists.
    function seriesExists(bytes32 seriesId) external view returns (bool);

    /// @notice True if new fills may be taken against this series right now:
    /// it exists, the guardian has not disabled it, and the factory is not paused.
    /// Settlement and refund are never gated by this.
    function isTradable(bytes32 seriesId) external view returns (bool);

    /// @notice Returns the finalized settlement record (zeroed if not yet published).
    function getSettlement(bytes32 seriesId) external view returns (Settlement memory);

    /// @notice True once `expiry + observationWindow + settlementGrace` has passed
    /// with no finalized settlement — the point at which positions become refundable.
    function isRefundable(bytes32 seriesId) external view returns (bool);
}
