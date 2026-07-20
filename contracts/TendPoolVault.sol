// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ITendSeriesFactory} from "./interfaces/ITendSeriesFactory.sol";

/// @title TendPoolVault
/// @notice Pooled writer liquidity for Tend option series. Anyone may deploy an
/// instance of this contract (the deployer becomes `manager`) and anyone may
/// deposit into it once the manager has pointed it at a settlement token and a
/// quote authority. Mirrors the Solana `vsol` program's `LiquidityPool` /
/// `PoolPosition` accounting exactly (see vsol/programs/vsol/src/lib.rs and
/// math.rs): share math rounds against value extraction, fills are authorized by
/// an EIP-712-signed quote from `quoteAuthority`, and settlement/refund are
/// always permissionless regardless of the guardian pause.
/// @dev Prototype — unaudited. It has not received an independent security audit.
contract TendPoolVault {
    enum Direction {
        Up,
        Down
    }

    struct PoolQuote {
        uint256 nonce;
        uint8 direction;
        uint128 strike;
        uint128 width;
        uint128 premium;
        uint128 maxPayout;
        uint64 quoteExpiry;
        bytes32 seriesId;
        address buyer;
    }

    struct SeriesAuth {
        bool enabled;
        uint64 lastTradeAt;
    }

    struct Position {
        address buyer;
        bytes32 seriesId;
        uint8 direction;
        uint128 strike;
        uint128 width;
        uint128 premium;
        uint128 maxPayout;
        uint16 feeBps;
        bool settled;
    }

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_FEE_BPS = 1_000;
    uint256 public constant MIN_TRADE_LEAD = 15 minutes;

    bytes32 public constant POOL_QUOTE_TYPEHASH = keccak256(
        "PoolQuote(uint256 nonce,uint8 direction,uint128 strike,uint128 width,uint128 premium,uint128 maxPayout,uint64 quoteExpiry,bytes32 seriesId,address buyer)"
    );
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant NAME_HASH = keccak256("Tend Pool Vault");
    bytes32 private constant VERSION_HASH = keccak256("1");

    ITendSeriesFactory public immutable factory;
    address public immutable asset;

    address public manager;
    address public quoteAuthority;
    address public feeRecipient;
    uint16 public feeBps;
    uint16 public maxUtilizationBps;
    uint16 public maxPositionBps;

    uint256 public totalShares;
    uint256 public totalAssets;
    uint256 public lockedCollateral;
    uint256 public escrowedPremium;
    uint256 public openPositions;
    uint256 public nextPositionId = 1;

    mapping(address => uint256) public sharesOf;
    mapping(bytes32 => SeriesAuth) public seriesAuth;
    mapping(uint256 => bool) public usedNonces;
    mapping(uint256 => Position) public positions;

    uint256 private _unlocked = 1;

    error NotManager();
    error InvalidAuthority();
    error InvalidPoolRiskLimits();
    error FeeTooHigh();
    error PoolHasOpenPositions();
    error SeriesNotFound();
    error SeriesSettlementTokenMismatch();
    error SeriesNotTradable();
    error SeriesNotAuthorized();
    error InvalidLastTradeCutoff();
    error LastTradeCutoffReached();
    error SeriesExpired();
    error QuoteExpired();
    error InvalidAmount();
    error InvalidWidth();
    error InvalidDirection();
    error InvalidBuyer();
    error AlreadyFilled();
    error BadSignature();
    error PoolUninitialized();
    error PoolUtilizationExceeded();
    error PoolPositionLimitExceeded();
    error InsufficientLiquidity();
    error CollateralMismatch();
    error PositionNotFound();
    error AlreadySettled();
    error NotFinalized();
    error SettlementWindowOpen();
    error SlippageExceeded();
    error DeadlineExpired();
    error InvalidPoolShares();
    error PoolInsolvent();
    error DepositTooSmall();
    error TokenTransferFailed();
    error Reentrant();

    event SeriesAuthorized(bytes32 indexed seriesId, bool enabled, uint64 lastTradeAt);
    event PoolUpdated(address quoteAuthority, uint16 maxUtilizationBps, uint16 maxPositionBps, uint16 feeBps, address feeRecipient);
    event ManagerTransferred(address indexed previousManager, address indexed newManager);
    event LiquidityDeposited(address indexed provider, uint256 amount, uint256 shares);
    event LiquidityWithdrawn(address indexed provider, uint256 amount, uint256 shares);
    event PoolQuoteFilled(
        uint256 indexed positionId,
        bytes32 indexed seriesId,
        address indexed buyer,
        uint256 nonce,
        uint256 premium,
        uint256 maxPayout
    );
    event PositionSettled(uint256 indexed positionId, uint256 settlementPrice, uint256 payout, uint256 poolAmount, uint256 fee);
    event PositionRefunded(uint256 indexed positionId, uint256 premium, uint256 collateral);

    modifier onlyManager() {
        if (msg.sender != manager) revert NotManager();
        _;
    }

    modifier nonReentrant() {
        if (_unlocked != 1) revert Reentrant();
        _unlocked = 2;
        _;
        _unlocked = 1;
    }

    constructor(
        address factory_,
        address asset_,
        address initialQuoteAuthority,
        uint16 initialMaxUtilizationBps,
        uint16 initialMaxPositionBps,
        uint16 initialFeeBps,
        address initialFeeRecipient
    ) {
        if (factory_ == address(0) || asset_ == address(0) || initialFeeRecipient == address(0)) {
            revert InvalidAuthority();
        }
        if (initialQuoteAuthority == address(0)) revert InvalidAuthority();
        if (initialFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        _validatePoolRiskLimits(initialMaxUtilizationBps, initialMaxPositionBps);

        factory = ITendSeriesFactory(factory_);
        asset = asset_;
        manager = msg.sender;
        quoteAuthority = initialQuoteAuthority;
        maxUtilizationBps = initialMaxUtilizationBps;
        maxPositionBps = initialMaxPositionBps;
        feeBps = initialFeeBps;
        feeRecipient = initialFeeRecipient;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function hashQuote(PoolQuote calldata quote) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(POOL_QUOTE_TYPEHASH, quote));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    // ---------------------------------------------------------------------
    // Manager controls — gated on zero open obligations, mirroring
    // `set_liquidity_pool_market` / `update_liquidity_pool` on Solana.
    // ---------------------------------------------------------------------

    /// @notice Authorizes (or revokes) trading against a series, with a
    /// per-series last-trade cutoff before the series' own expiry.
    function authorizeSeries(bytes32 seriesId, bool enabled, uint64 lastTradeAt) external onlyManager {
        if (openPositions != 0 || lockedCollateral != 0) revert PoolHasOpenPositions();
        if (!factory.seriesExists(seriesId)) revert SeriesNotFound();
        ITendSeriesFactory.Series memory series = factory.getSeries(seriesId);
        if (series.settlementToken != asset) revert SeriesSettlementTokenMismatch();

        if (enabled) {
            if (lastTradeAt < block.timestamp + MIN_TRADE_LEAD || lastTradeAt >= series.expiry) {
                revert InvalidLastTradeCutoff();
            }
        }

        seriesAuth[seriesId] = SeriesAuth({enabled: enabled, lastTradeAt: lastTradeAt});
        emit SeriesAuthorized(seriesId, enabled, lastTradeAt);
    }

    /// @notice Updates the quote authority and risk caps. Only when the pool has
    /// no open positions and no locked collateral, exactly like Solana's
    /// `update_liquidity_pool`.
    function updatePool(
        address nextQuoteAuthority,
        uint16 nextMaxUtilizationBps,
        uint16 nextMaxPositionBps,
        uint16 nextFeeBps,
        address nextFeeRecipient
    ) external onlyManager {
        if (openPositions != 0 || lockedCollateral != 0) revert PoolHasOpenPositions();
        if (nextQuoteAuthority == address(0) || nextFeeRecipient == address(0)) revert InvalidAuthority();
        if (nextFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        _validatePoolRiskLimits(nextMaxUtilizationBps, nextMaxPositionBps);

        quoteAuthority = nextQuoteAuthority;
        maxUtilizationBps = nextMaxUtilizationBps;
        maxPositionBps = nextMaxPositionBps;
        feeBps = nextFeeBps;
        feeRecipient = nextFeeRecipient;
        emit PoolUpdated(nextQuoteAuthority, nextMaxUtilizationBps, nextMaxPositionBps, nextFeeBps, nextFeeRecipient);
    }

    /// @notice Hands over pool management to a new address. Only when the pool
    /// has no open positions and no locked collateral, exactly like
    /// `authorizeSeries` / `updatePool` — handing over control mid-obligation
    /// would change who governs live risk.
    function transferManager(address nextManager) external onlyManager {
        if (openPositions != 0 || lockedCollateral != 0) revert PoolHasOpenPositions();
        if (nextManager == address(0)) revert InvalidAuthority();
        address previousManager = manager;
        manager = nextManager;
        emit ManagerTransferred(previousManager, nextManager);
    }

    // ---------------------------------------------------------------------
    // Liquidity provision — only while the pool has zero open obligations.
    // ---------------------------------------------------------------------

    function deposit(uint256 amount, uint256 minSharesOut, uint256 deadline) external nonReentrant returns (uint256 shares) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (openPositions != 0 || lockedCollateral != 0) revert PoolHasOpenPositions();

        shares = calculateDepositShares(amount, totalShares, totalAssets);
        if (shares < minSharesOut) revert SlippageExceeded();

        _safeTransferFromExact(msg.sender, address(this), amount);

        totalAssets += amount;
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        emit LiquidityDeposited(msg.sender, amount, shares);
    }

    function withdraw(uint256 shares, uint256 minAmountOut, uint256 deadline) external nonReentrant returns (uint256 amount) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (openPositions != 0 || lockedCollateral != 0) revert PoolHasOpenPositions();
        if (sharesOf[msg.sender] < shares) revert InvalidPoolShares();

        amount = calculateWithdrawAmount(shares, totalShares, totalAssets);
        if (amount < minAmountOut) revert SlippageExceeded();

        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        totalAssets -= amount;

        _safeTransfer(msg.sender, amount);
        emit LiquidityWithdrawn(msg.sender, amount, shares);
    }

    // ---------------------------------------------------------------------
    // Fill / settle / refund
    // ---------------------------------------------------------------------

    function fillPoolQuote(PoolQuote calldata quote, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 positionId)
    {
        if (!factory.isTradable(quote.seriesId)) revert SeriesNotTradable();
        SeriesAuth memory auth = seriesAuth[quote.seriesId];
        if (!auth.enabled) revert SeriesNotAuthorized();
        ITendSeriesFactory.Series memory series = factory.getSeries(quote.seriesId);

        if (block.timestamp >= series.expiry) revert SeriesExpired();
        if (block.timestamp >= auth.lastTradeAt) revert LastTradeCutoffReached();
        if (
            block.timestamp > quote.quoteExpiry || quote.quoteExpiry > auth.lastTradeAt
                || quote.quoteExpiry >= series.expiry
        ) revert QuoteExpired();
        if (quote.premium == 0 || quote.maxPayout == 0) revert InvalidAmount();
        if (quote.strike == 0 || quote.width == 0) revert InvalidWidth();
        if (quote.direction > uint8(Direction.Down)) revert InvalidDirection();
        if (quote.buyer != msg.sender) revert InvalidBuyer();
        if (totalShares == 0) revert PoolInsolvent();
        if (usedNonces[quote.nonce]) revert AlreadyFilled();

        bytes32 digest = hashQuote(quote);
        if (_recover(digest, signature) != quoteAuthority) revert BadSignature();
        usedNonces[quote.nonce] = true;

        uint256 totalCollateral = totalAssets + lockedCollateral;
        uint256 utilizationLimit = calculateBpsLimit(totalCollateral, maxUtilizationBps);
        uint256 positionLimit = calculateBpsLimit(totalCollateral, maxPositionBps);
        uint256 lockedAfter = lockedCollateral + quote.maxPayout;
        if (lockedAfter > utilizationLimit) revert PoolUtilizationExceeded();
        if (quote.maxPayout > positionLimit) revert PoolPositionLimitExceeded();
        if (totalAssets < quote.maxPayout) revert InsufficientLiquidity();

        _safeTransferFromExact(msg.sender, address(this), quote.premium);

        totalAssets -= quote.maxPayout;
        lockedCollateral = lockedAfter;
        escrowedPremium += quote.premium;
        openPositions += 1;

        positionId = nextPositionId++;
        positions[positionId] = Position({
            buyer: quote.buyer,
            seriesId: quote.seriesId,
            direction: quote.direction,
            strike: quote.strike,
            width: quote.width,
            premium: quote.premium,
            maxPayout: quote.maxPayout,
            feeBps: feeBps,
            settled: false
        });

        emit PoolQuoteFilled(positionId, quote.seriesId, quote.buyer, quote.nonce, quote.premium, quote.maxPayout);
    }

    /// @notice Settles an open position against the series' finalized Pyth
    /// settlement price. Permissionless and available regardless of guardian
    /// pause or per-series disable.
    function settlePoolPosition(uint256 positionId) external nonReentrant returns (uint256 payout) {
        Position storage position = positions[positionId];
        if (position.buyer == address(0)) revert PositionNotFound();
        if (position.settled) revert AlreadySettled();

        ITendSeriesFactory.Settlement memory settlement = factory.getSettlement(position.seriesId);
        if (!settlement.finalized) revert NotFinalized();

        payout = calculatePayout(position.direction, position.strike, position.width, settlement.price, position.maxPayout);
        uint256 fee = calculateFee(position.premium, position.feeBps);
        uint256 poolAmount = position.maxPayout - payout + position.premium - fee;

        uint256 expected = uint256(position.premium) + position.maxPayout;
        if (payout + poolAmount + fee != expected) revert CollateralMismatch();

        position.settled = true;
        lockedCollateral -= position.maxPayout;
        escrowedPremium -= position.premium;
        openPositions -= 1;
        totalAssets += poolAmount;

        if (payout > 0) _safeTransfer(position.buyer, payout);
        if (fee > 0) _safeTransfer(feeRecipient, fee);

        emit PositionSettled(positionId, settlement.price, payout, poolAmount, fee);
    }

    /// @notice Refunds an open position once the series has passed
    /// `expiry + observationWindow + settlementGrace` with no finalized
    /// settlement. Anyone may call this; permissionless like settlement.
    function refundPoolPosition(uint256 positionId) external nonReentrant {
        Position storage position = positions[positionId];
        if (position.buyer == address(0)) revert PositionNotFound();
        if (position.settled) revert AlreadySettled();
        if (!factory.isRefundable(position.seriesId)) revert SettlementWindowOpen();

        position.settled = true;
        lockedCollateral -= position.maxPayout;
        escrowedPremium -= position.premium;
        openPositions -= 1;
        totalAssets += position.maxPayout;

        _safeTransfer(position.buyer, position.premium);
        emit PositionRefunded(positionId, position.premium, position.maxPayout);
    }

    // ---------------------------------------------------------------------
    // Math — mirrors vsol/programs/vsol/src/math.rs exactly (rounding
    // direction and edge cases included).
    // ---------------------------------------------------------------------

    /// @notice Returns the buyer payout, rounded down. The pool receives all
    /// residual dust.
    function calculatePayout(uint8 direction, uint256 strike, uint256 width, uint256 settlementPrice, uint256 maxPayout)
        public
        pure
        returns (uint256)
    {
        if (width == 0) revert InvalidWidth();
        if (maxPayout == 0) revert InvalidAmount();

        uint256 delta;
        if (direction == uint8(Direction.Up)) {
            delta = settlementPrice > strike ? settlementPrice - strike : 0;
        } else if (direction == uint8(Direction.Down)) {
            delta = strike > settlementPrice ? strike - settlementPrice : 0;
        } else {
            revert InvalidDirection();
        }
        if (delta > width) delta = width;

        return (maxPayout * delta) / width;
    }

    /// @notice Protocol fees round up so a positive fee rate cannot be
    /// bypassed with dust quotes.
    function calculateFee(uint256 premium, uint16 feeBps_) public pure returns (uint256) {
        if (premium == 0 || feeBps_ == 0) return 0;
        return (premium * feeBps_ + (BPS_DENOMINATOR - 1)) / BPS_DENOMINATOR;
    }

    /// @notice Mints pool shares conservatively. Deposits round down so a
    /// depositor cannot dilute existing liquidity providers through integer
    /// division.
    function calculateDepositShares(uint256 amount, uint256 totalSharesValue, uint256 totalAssetsValue)
        public
        pure
        returns (uint256)
    {
        if (amount == 0) revert InvalidAmount();
        if (totalSharesValue == 0) return amount;
        if (totalAssetsValue == 0) revert PoolInsolvent();
        uint256 out = (amount * totalSharesValue) / totalAssetsValue;
        if (out == 0) revert DepositTooSmall();
        return out;
    }

    /// @notice Returns underlying assets conservatively. Withdrawals round
    /// down and leave any division dust in the pool for remaining providers.
    function calculateWithdrawAmount(uint256 shares, uint256 totalSharesValue, uint256 totalAssetsValue)
        public
        pure
        returns (uint256)
    {
        if (shares == 0) revert InvalidAmount();
        if (totalSharesValue == 0) revert InvalidPoolShares();
        if (shares > totalSharesValue) revert InvalidPoolShares();
        uint256 out = (shares * totalAssetsValue) / totalSharesValue;
        if (out == 0) revert DepositTooSmall();
        return out;
    }

    function calculateBpsLimit(uint256 amount, uint16 bps) public pure returns (uint256) {
        return (amount * bps) / BPS_DENOMINATOR;
    }

    function _validatePoolRiskLimits(uint16 maxUtilizationBps_, uint16 maxPositionBps_) private pure {
        bool ok = maxUtilizationBps_ > 0 && uint256(maxUtilizationBps_) <= BPS_DENOMINATOR && maxPositionBps_ > 0
            && maxPositionBps_ <= maxUtilizationBps_;
        if (!ok) revert InvalidPoolRiskLimits();
    }

    // ---------------------------------------------------------------------
    // ECDSA + low-level ERC20 helpers (mirrors TendMarket.sol's style).
    // ---------------------------------------------------------------------

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) revert BadSignature();
        if (v != 27 && v != 28) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = asset.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }

    function _safeTransferFromExact(address from, address to, uint256 amount) private {
        uint256 balanceBefore = _balanceOf(to);
        _safeTransferFrom(from, to, amount);
        uint256 balanceAfter = _balanceOf(to);
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) revert TokenTransferFailed();
    }

    function _balanceOf(address account) private view returns (uint256 balance) {
        (bool ok, bytes memory data) = asset.staticcall(abi.encodeWithSelector(0x70a08231, account));
        if (!ok || data.length < 32) revert TokenTransferFailed();
        balance = abi.decode(data, (uint256));
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory data) = asset.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }
}
