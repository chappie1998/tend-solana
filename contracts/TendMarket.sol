// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ITendSettlementOracle} from "./interfaces/ITendSettlementOracle.sol";
import {ITendEligibility} from "./interfaces/ITendEligibility.sol";

/// @title TendMarket
/// @notice Fully collateralized, capped-payout option RFQs.
/// @dev Prototype only. It has not received an independent security audit.
contract TendMarket {
    enum Direction { Up, Down }

    struct Quote {
        address maker;
        address buyer;
        address underlying;
        address collateralToken;
        address oracle;
        uint128 premium;
        uint128 maxPayout;
        uint128 strike;
        uint128 capPrice;
        uint64 expiry;
        uint64 deadline;
        uint64 nonce;
        Direction direction;
    }

    struct Position {
        address maker;
        address buyer;
        address underlying;
        address collateralToken;
        address oracle;
        uint128 premium;
        uint128 maxPayout;
        uint128 strike;
        uint128 capPrice;
        uint64 expiry;
        Direction direction;
        bool settled;
    }

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(address maker,address buyer,address underlying,address collateralToken,address oracle,uint128 premium,uint128 maxPayout,uint128 strike,uint128 capPrice,uint64 expiry,uint64 deadline,uint64 nonce,uint8 direction)"
    );
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant NAME_HASH = keccak256("Tend Market");
    bytes32 private constant VERSION_HASH = keccak256("1");

    address public owner;
    address public emergencyAdmin;
    ITendEligibility public eligibility;
    bool public paused;
    uint256 public nextPositionId = 1;

    mapping(address => bool) public approvedMakers;
    mapping(address => bool) public approvedOracles;
    mapping(address => mapping(uint64 => bool)) public cancelledNonces;
    mapping(bytes32 => bool) public filledQuotes;
    mapping(uint256 => Position) public positions;

    uint256 private unlocked = 1;

    error AlreadyFilled();
    error AlreadySettled();
    error BadDirectionRange();
    error BadSignature();
    error Ineligible();
    error InvalidQuote();
    error NotApproved();
    error NotFinalized();
    error NotOwner();
    error NotPauseAuthority();
    error NotReady();
    error Paused();
    error Reentrant();
    error TokenTransferFailed();

    event QuoteFilled(bytes32 indexed quoteHash, uint256 indexed positionId, address indexed buyer, address maker);
    event QuoteNonceCancelled(address indexed maker, uint64 indexed nonce);
    event PositionSettled(uint256 indexed positionId, uint256 settlementPrice, uint256 payout);
    event MakerApprovalSet(address indexed maker, bool approved);
    event OracleApprovalSet(address indexed oracle, bool approved);
    event PauseSet(bool paused);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (unlocked != 1) revert Reentrant();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(address initialOwner, address initialEmergencyAdmin, ITendEligibility initialEligibility) {
        if (initialOwner == address(0) || initialEmergencyAdmin == address(0)) revert InvalidQuote();
        owner = initialOwner;
        emergencyAdmin = initialEmergencyAdmin;
        eligibility = initialEligibility;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            NAME_HASH,
            VERSION_HASH,
            block.chainid,
            address(this)
        ));
    }

    function hashQuote(Quote calldata quote) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            QUOTE_TYPEHASH,
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
            quote.direction
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function fillQuote(Quote calldata quote, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 positionId)
    {
        if (paused) revert Paused();
        if (!approvedMakers[quote.maker] || !approvedOracles[quote.oracle]) revert NotApproved();
        if (quote.buyer != address(0) && quote.buyer != msg.sender) revert InvalidQuote();
        if (
            quote.maker == address(0) || quote.underlying == address(0) ||
            quote.collateralToken == address(0) || quote.premium == 0 ||
            quote.maxPayout == 0 || quote.strike == 0 ||
            quote.expiry <= block.timestamp || quote.deadline < block.timestamp
        ) revert InvalidQuote();
        if (quote.direction == Direction.Up && quote.capPrice <= quote.strike) revert BadDirectionRange();
        if (quote.direction == Direction.Down && quote.capPrice >= quote.strike) revert BadDirectionRange();
        if (cancelledNonces[quote.maker][quote.nonce]) revert AlreadyFilled();
        if (address(eligibility) != address(0)) {
            if (!eligibility.canTrade(msg.sender, quote.underlying) || !eligibility.canTrade(quote.maker, quote.underlying)) {
                revert Ineligible();
            }
        }

        bytes32 digest = hashQuote(quote);
        if (filledQuotes[digest]) revert AlreadyFilled();
        if (_recover(digest, signature) != quote.maker) revert BadSignature();

        filledQuotes[digest] = true;
        positionId = nextPositionId++;
        positions[positionId] = Position({
            maker: quote.maker,
            buyer: msg.sender,
            underlying: quote.underlying,
            collateralToken: quote.collateralToken,
            oracle: quote.oracle,
            premium: quote.premium,
            maxPayout: quote.maxPayout,
            strike: quote.strike,
            capPrice: quote.capPrice,
            expiry: quote.expiry,
            direction: quote.direction,
            settled: false
        });

        _safeTransferFrom(quote.collateralToken, quote.maker, address(this), quote.maxPayout);
        _safeTransferFrom(quote.collateralToken, msg.sender, quote.maker, quote.premium);
        emit QuoteFilled(digest, positionId, msg.sender, quote.maker);
    }

    /// @notice Settlement remains available while fills are paused.
    function settle(uint256 positionId) external nonReentrant returns (uint256 payout) {
        Position storage position = positions[positionId];
        if (position.buyer == address(0)) revert InvalidQuote();
        if (position.settled) revert AlreadySettled();
        if (block.timestamp < position.expiry) revert NotReady();

        (uint256 settlementValue, uint64 observedAt, bool finalized) =
            ITendSettlementOracle(position.oracle).settlementPrice(position.underlying, position.expiry);
        if (!finalized || observedAt < position.expiry || settlementValue == 0) revert NotFinalized();

        payout = payoutAt(
            position.direction,
            settlementValue,
            position.strike,
            position.capPrice,
            position.maxPayout
        );
        position.settled = true;

        if (payout != 0) _safeTransfer(position.collateralToken, position.buyer, payout);
        uint256 remainder = uint256(position.maxPayout) - payout;
        if (remainder != 0) _safeTransfer(position.collateralToken, position.maker, remainder);
        emit PositionSettled(positionId, settlementValue, payout);
    }

    function payoutAt(
        Direction direction,
        uint256 settlementValue,
        uint256 strike,
        uint256 capPrice,
        uint256 maxPayout
    ) public pure returns (uint256) {
        if (direction == Direction.Up) {
            if (capPrice <= strike) revert BadDirectionRange();
            if (settlementValue <= strike) return 0;
            uint256 boundedUp = settlementValue > capPrice ? capPrice : settlementValue;
            return maxPayout * (boundedUp - strike) / (capPrice - strike);
        }
        if (capPrice >= strike) revert BadDirectionRange();
        if (settlementValue >= strike) return 0;
        uint256 boundedDown = settlementValue < capPrice ? capPrice : settlementValue;
        return maxPayout * (strike - boundedDown) / (strike - capPrice);
    }

    function cancelNonce(uint64 nonce) external {
        cancelledNonces[msg.sender][nonce] = true;
        emit QuoteNonceCancelled(msg.sender, nonce);
    }

    function setMaker(address maker, bool approved) external onlyOwner {
        approvedMakers[maker] = approved;
        emit MakerApprovalSet(maker, approved);
    }

    function setOracle(address oracle, bool approved) external onlyOwner {
        approvedOracles[oracle] = approved;
        emit OracleApprovalSet(oracle, approved);
    }

    function setEligibility(ITendEligibility nextEligibility) external onlyOwner { eligibility = nextEligibility; }

    function setPaused(bool nextPaused) external {
        if (msg.sender != owner && msg.sender != emergencyAdmin) revert NotPauseAuthority();
        paused = nextPaused;
        emit PauseSet(nextPaused);
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert InvalidQuote();
        owner = nextOwner;
    }

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

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }
}
