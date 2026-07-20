// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {ITendSeriesFactory} from "./interfaces/ITendSeriesFactory.sol";

/// @title TendSeriesFactory
/// @notice Permissionless creation of option series ("markets") plus permissionless,
/// Pyth-verified settlement publication. No admin ever selects or attests a price.
/// @dev Prototype — unaudited. Mirrors the Solana `vsol` program's `create_market` /
/// `publish_pyth_settlement` semantics (see vsol/programs/vsol/src/lib.rs and pyth.rs).
contract TendSeriesFactory is ITendSeriesFactory {
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MIN_SERIES_LEAD = 15 minutes;
    uint256 public constant MAX_OBSERVATION_WINDOW = 1 hours;
    uint256 public constant MAX_SETTLEMENT_GRACE = 24 hours;
    uint256 public constant MAX_CONFIDENCE_BPS = 2_000;
    uint256 public constant PRICE_SCALE = 1e8;
    uint256 public constant MAX_PYTH_EXPONENT_ABS = 18;

    struct CreateSeriesParams {
        bytes32 pythFeedId;
        address settlementToken;
        uint64 expiry;
        uint32 observationWindow;
        uint32 settlementGrace;
        uint16 maxConfidenceBps;
        bytes32 symbol;
    }

    IPyth public immutable pyth;
    address public owner;
    address public emergencyAdmin;
    bool public paused;

    mapping(bytes32 => Series) private _series;
    mapping(bytes32 => bool) private _seriesExists;
    mapping(bytes32 => Settlement) private _settlements;

    error InvalidAuthority();
    error NotOwner();
    error NotPauseAuthority();
    error Paused();
    error SeriesAlreadyExists();
    error SeriesNotFound();
    error InvalidExpiry();
    error InvalidObservationWindow();
    error InvalidSettlementGrace();
    error InvalidConfidence();
    error InvalidSymbol();
    error InvalidPythFeed();
    error InvalidSettlementToken();
    error AlreadyFinalized();
    error SeriesNotExpired();
    error SettlementWindowClosed();
    error InsufficientFee();
    error RefundFailed();
    error InvalidOraclePrice();
    error InvalidPythExponent();
    error InvalidObservationTime();
    error OracleConfidenceTooWide();
    error Reentrant();

    event SeriesCreated(
        bytes32 indexed seriesId,
        address indexed creator,
        bytes32 pythFeedId,
        address settlementToken,
        uint64 expiry,
        uint32 observationWindow,
        uint32 settlementGrace,
        uint16 maxConfidenceBps,
        bytes32 symbol
    );
    event SeriesEnabledSet(bytes32 indexed seriesId, bool enabled);
    event PauseSet(bool paused);
    event SettlementPublished(bytes32 indexed seriesId, uint256 price, uint64 publishTime);

    uint256 private _unlocked = 1;

    modifier nonReentrant() {
        if (_unlocked != 1) revert Reentrant();
        _unlocked = 2;
        _;
        _unlocked = 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address initialOwner, address initialEmergencyAdmin, IPyth pythContract) {
        if (initialOwner == address(0) || initialEmergencyAdmin == address(0) || address(pythContract) == address(0)) {
            revert InvalidAuthority();
        }
        owner = initialOwner;
        emergencyAdmin = initialEmergencyAdmin;
        pyth = pythContract;
    }

    /// @notice Deterministically derives the series id from its canonical parameters:
    /// `keccak256(abi.encode("TENDMKT1", pythFeedId, settlementToken, expiry,
    /// observationWindow, settlementGrace, maxConfidenceBps, symbol))`.
    function deriveSeriesId(CreateSeriesParams calldata params) public pure returns (bytes32) {
        return keccak256(
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
    }

    /// @notice Permissionlessly creates a series. Anyone may call this — there is no
    /// allowlist for creators. Duplicate parameter tuples resolve to the same
    /// deterministic id and revert on the second attempt.
    function createSeries(CreateSeriesParams calldata params) external returns (bytes32 seriesId) {
        if (paused) revert Paused();
        if (params.expiry < block.timestamp + MIN_SERIES_LEAD) revert InvalidExpiry();
        if (params.observationWindow == 0 || params.observationWindow > MAX_OBSERVATION_WINDOW) {
            revert InvalidObservationWindow();
        }
        if (params.settlementGrace == 0 || params.settlementGrace > MAX_SETTLEMENT_GRACE) {
            revert InvalidSettlementGrace();
        }
        if (params.maxConfidenceBps == 0 || params.maxConfidenceBps > MAX_CONFIDENCE_BPS) {
            revert InvalidConfidence();
        }
        if (params.symbol == bytes32(0)) revert InvalidSymbol();
        if (params.pythFeedId == bytes32(0)) revert InvalidPythFeed();
        if (params.settlementToken == address(0)) revert InvalidSettlementToken();

        seriesId = deriveSeriesId(params);
        if (_seriesExists[seriesId]) revert SeriesAlreadyExists();

        _seriesExists[seriesId] = true;
        _series[seriesId] = Series({
            creator: msg.sender,
            pythFeedId: params.pythFeedId,
            settlementToken: params.settlementToken,
            expiry: params.expiry,
            observationWindow: params.observationWindow,
            settlementGrace: params.settlementGrace,
            maxConfidenceBps: params.maxConfidenceBps,
            symbol: params.symbol,
            enabled: true
        });

        emit SeriesCreated(
            seriesId,
            msg.sender,
            params.pythFeedId,
            params.settlementToken,
            params.expiry,
            params.observationWindow,
            params.settlementGrace,
            params.maxConfidenceBps,
            params.symbol
        );
    }

    /// @notice Guardian kill-switch: disables (or re-enables) new fills against a
    /// series. Never blocks settlement or refund of already-open positions.
    function setSeriesEnabled(bytes32 seriesId, bool enabled) external onlyOwner {
        if (!_seriesExists[seriesId]) revert SeriesNotFound();
        _series[seriesId].enabled = enabled;
        emit SeriesEnabledSet(seriesId, enabled);
    }

    /// @notice Owner or emergency admin can halt new series creation and new fills
    /// protocol-wide. Settlement and refund remain available while paused.
    function setPaused(bool nextPaused) external {
        if (msg.sender != owner && msg.sender != emergencyAdmin) revert NotPauseAuthority();
        paused = nextPaused;
        emit PauseSet(nextPaused);
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert InvalidAuthority();
        owner = nextOwner;
    }

    function setEmergencyAdmin(address nextEmergencyAdmin) external onlyOwner {
        if (nextEmergencyAdmin == address(0)) revert InvalidAuthority();
        emergencyAdmin = nextEmergencyAdmin;
    }

    /// @notice Permissionlessly publishes the finalized settlement price for an
    /// expired series from a Pyth price update. Anyone may call this and pay the
    /// Pyth update fee; no admin selects or attests the price. The update must carry
    /// the series' exact feed id and a publish time inside
    /// `[expiry, expiry + observationWindow]`, and the confidence interval must be
    /// within `maxConfidenceBps` of the price. Finalizes exactly once.
    function publishSettlement(bytes32 seriesId, bytes[] calldata updateData)
        external
        payable
        nonReentrant
        returns (uint256 price)
    {
        if (!_seriesExists[seriesId]) revert SeriesNotFound();
        Series memory series = _series[seriesId];
        if (_settlements[seriesId].finalized) revert AlreadyFinalized();
        if (block.timestamp < series.expiry) revert SeriesNotExpired();

        uint256 observationEnd = uint256(series.expiry) + series.observationWindow;
        uint256 settlementDeadline = observationEnd + series.settlementGrace;
        if (block.timestamp > settlementDeadline) revert SettlementWindowClosed();

        uint256 fee = pyth.getUpdateFee(updateData);
        if (msg.value < fee) revert InsufficientFee();

        bytes32[] memory priceIds = new bytes32[](1);
        priceIds[0] = series.pythFeedId;
        PythStructs.PriceFeed[] memory feeds = pyth.parsePriceFeedUpdates{value: fee}(
            updateData, priceIds, uint64(series.expiry), uint64(observationEnd)
        );
        PythStructs.Price memory pythPrice = feeds[0].price;

        if (pythPrice.price <= 0) revert InvalidOraclePrice();
        if (pythPrice.publishTime < series.expiry || pythPrice.publishTime > observationEnd) {
            revert InvalidObservationTime();
        }

        // Confidence-vs-price ratio is exponent-invariant, so the bound can be
        // checked on the raw Pyth values before normalizing to PRICE_SCALE.
        uint256 rawPrice = uint256(uint64(pythPrice.price));
        uint256 rawConf = uint256(pythPrice.conf);
        if (rawConf * BPS_DENOMINATOR > rawPrice * series.maxConfidenceBps) {
            revert OracleConfidenceTooWide();
        }

        price = _normalizePrice(pythPrice.price, pythPrice.expo);
        _settlements[seriesId] =
            Settlement({finalized: true, price: price, publishTime: uint64(pythPrice.publishTime)});

        emit SettlementPublished(seriesId, price, uint64(pythPrice.publishTime));

        uint256 refund = msg.value - fee;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    function _normalizePrice(int64 rawPrice, int32 expo) private pure returns (uint256) {
        int256 expoInt = int256(expo);
        uint256 absExpo = uint256(expoInt < 0 ? -expoInt : expoInt);
        if (absExpo > MAX_PYTH_EXPONENT_ABS) revert InvalidPythExponent();
        uint256 power = 10 ** absExpo;
        uint256 value = uint256(uint64(rawPrice));
        return expo >= 0 ? value * PRICE_SCALE * power : (value * PRICE_SCALE) / power;
    }

    // ---------------------------------------------------------------------
    // ITendSeriesFactory view surface
    // ---------------------------------------------------------------------

    function getSeries(bytes32 seriesId) external view returns (Series memory) {
        if (!_seriesExists[seriesId]) revert SeriesNotFound();
        return _series[seriesId];
    }

    function seriesExists(bytes32 seriesId) external view returns (bool) {
        return _seriesExists[seriesId];
    }

    function isTradable(bytes32 seriesId) external view returns (bool) {
        return _seriesExists[seriesId] && _series[seriesId].enabled && !paused;
    }

    function getSettlement(bytes32 seriesId) external view returns (Settlement memory) {
        return _settlements[seriesId];
    }

    function isRefundable(bytes32 seriesId) external view returns (bool) {
        if (!_seriesExists[seriesId]) return false;
        Settlement memory settlement = _settlements[seriesId];
        if (settlement.finalized) return false;
        Series memory series = _series[seriesId];
        uint256 deadline = uint256(series.expiry) + series.observationWindow + series.settlementGrace;
        return block.timestamp > deadline;
    }
}
