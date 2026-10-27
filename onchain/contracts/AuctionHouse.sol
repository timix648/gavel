// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {GavelLot} from "./GavelLot.sol";
import {LotVault} from "./LotVault.sol";

interface IUSDC3009 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

interface IReputationWriter {
    function cleanSalesView(address seller) external view returns (uint256);
}

/// @title AuctionHouse v8
/// @notice Live USDC auction house on Arc. Supports off-chain lots and on-chain
///         asset lots (ERC721, ERC1155, ERC20). All USDC amounts in 6-decimal units.
///
/// v8 changes over v7:
///   A1. Top-up bidding: bids draw from claimable first.
///   A2. _payOut: push payments direct to wallet, fall back to claimable on blocklist.
///   A3. refundBuyer takes a reason string (max 280 bytes).
///   A4. submitEvidence: buyer or seller may submit text (max 1000 bytes, max 10 each).
contract AuctionHouse is Ownable, ReentrancyGuard {

    // ─── Lot kind ────────────────────────────────────────────────────────────────
    enum Kind { OFFCHAIN, ERC721, ERC1155, ERC20 }

    // ─── OFFCHAIN escrow state ───────────────────────────────────────────────────
    enum EscrowState { NONE, HELD, DISPUTED, CLOSED }

    // ─── Constants ──────────────────────────────────────────────────────────────
    uint256 public constant MAX_RESERVE_CAP   = 100_000_000_000; // 100,000 USDC hard cap
    uint256 public constant SOFT_CLOSE_WINDOW = 10;
    uint256 public constant MAX_EXTENSIONS    = 500;
    uint256 public constant DELIVERY_WINDOW   = 7 days;
    uint256 public constant DISPUTE_RESOLVE_TIMEOUT = 14 days;
    uint256 public constant MAX_EVIDENCE_BYTES = 1_000;
    uint256 public constant MAX_EVIDENCE_PER_PARTY = 10;
    uint256 public constant MAX_REFUND_REASON_BYTES = 280;

    /// @notice Owner-adjustable reserve cap, default 1,000 USDC.
    uint256 public maxReserve = 1_000_000_000; // 1,000 USDC (6 dec)

    // ─── Allowlist ───────────────────────────────────────────────────────────────
    mapping(address => uint8) internal _allowedAssetKind;

    // ─── Lot storage ────────────────────────────────────────────────────────────
    struct Lot {
        address seller;
        uint256 tokenId;
        uint256 reserve;
        uint256 minIncrement;
        uint256 bond;
        uint256 deadline;
        uint256 highestBid;
        address highestBidder;
        uint256 extensions;
        uint256 settledAt;
        bool    settled;
        bool    cancelled;
        bool    bondReleased;
        bool    disputed;
    }

    mapping(uint256 => Lot)         public lots;
    mapping(uint256 => Kind)        internal _lotKind;
    mapping(uint256 => address)     internal _lotAsset;
    mapping(uint256 => uint256)     internal _lotAmount;
    mapping(uint256 => EscrowState) internal _escrowState;
    mapping(uint256 => bool)        internal _assetClaimed;
    mapping(uint256 => uint256)     internal _disputedAt;

    uint256 public nextLotId;

    mapping(address => uint256) public claimable;

    bool public paused;
    address public reputationWriter;

    // ─── Evidence counters ────────────────────────────────────────────────────
    // evidenceCount[lotId][party] = number of submissions
    mapping(uint256 => mapping(address => uint256)) internal _evidenceCount;

    // ─── Immutable trusted addresses ────────────────────────────────────────────
    GavelLot public immutable gavelLot;
    LotVault public immutable lotVault;
    IUSDC3009 public immutable usdc;

    // ─── Events ─────────────────────────────────────────────────────────────────
    event Listed(uint256 indexed lotId, address indexed seller, uint256 tokenId, uint256 reserve, uint256 deadline);
    event Bid(uint256 indexed lotId, address indexed bidder, uint256 amount);
    event CreditUsed(uint256 indexed lotId, address indexed bidder, uint256 credit);
    event RelayedBid(uint256 indexed lotId, address indexed bidder, address indexed relayer, uint256 amount);
    event Outbid(uint256 indexed lotId, address indexed previousBidder, uint256 previousBid);
    event Extended(uint256 indexed lotId, uint256 newDeadline, uint256 extensions);
    event Hammer(uint256 indexed lotId, address indexed winner, uint256 amount);
    event Unsold(uint256 indexed lotId, address indexed seller);
    event Claimed(address indexed claimant, uint256 amount);
    event Cancelled(uint256 indexed lotId, address indexed seller);
    event BondHeld(uint256 indexed lotId, uint256 bond);
    event BondReleased(uint256 indexed lotId, address indexed recipient, uint256 bond);
    event Disputed(uint256 indexed lotId, address indexed winner);
    event DisputeResolved(uint256 indexed lotId, bool sellerAtFault);
    event ReputationWriterUpdated(address indexed oldWriter, address indexed newWriter);
    event AssetClaimed(uint256 indexed lotId, address indexed claimant, address indexed to);
    event EscrowReleased(uint256 indexed lotId, address indexed seller, uint256 amount);
    event BuyerRefunded(uint256 indexed lotId, address indexed buyer, uint256 amount, string reason);
    event AllowedAssetSet(address indexed asset, Kind kind, bool allowed);
    event MaxReserveSet(uint256 newMaxReserve);
    event PaidOut(address indexed to, uint256 amount, bool pushed);
    event Evidence(uint256 indexed lotId, address indexed party, string text);

    // ─── Constructor ────────────────────────────────────────────────────────────
    constructor(address initialOwner) Ownable(msg.sender) {
        require(initialOwner != address(0), "AuctionHouse: zero owner");
        gavelLot = new GavelLot(address(this));
        lotVault = new LotVault(address(this));
        usdc = IUSDC3009(0x3600000000000000000000000000000000000000);
        transferOwnership(initialOwner);
    }

    // ─── Admin ──────────────────────────────────────────────────────────────────

    function renounceOwnership() public override onlyOwner {
        revert("AuctionHouse: renounce disabled");
    }

    function pause() external onlyOwner { paused = true; }
    function unpause() external onlyOwner { paused = false; }

    function setReputationWriter(address rw) external onlyOwner {
        emit ReputationWriterUpdated(reputationWriter, rw);
        reputationWriter = rw;
    }

    function setAllowedAsset(address asset, Kind kind, bool allow) external onlyOwner {
        require(kind != Kind.OFFCHAIN, "AuctionHouse: OFFCHAIN not an asset kind");
        require(asset != address(usdc), "AuctionHouse: USDC not allowed");
        require(asset != address(gavelLot), "AuctionHouse: GavelLot not allowed");
        require(asset != address(this) && asset != address(lotVault), "AuctionHouse: self not allowed");
        if (allow) {
            _allowedAssetKind[asset] = uint8(kind) + 1;
        } else {
            _allowedAssetKind[asset] = 0;
        }
        emit AllowedAssetSet(asset, kind, allow);
    }

    function setMaxReserve(uint256 newMax) external onlyOwner {
        require(newMax > 0 && newMax <= MAX_RESERVE_CAP, "AuctionHouse: invalid max reserve");
        maxReserve = newMax;
        emit MaxReserveSet(newMax);
    }

    // ─── View helpers ────────────────────────────────────────────────────────────

    function lotKind(uint256 lotId) external view returns (Kind) { return _lotKind[lotId]; }
    function lotAsset(uint256 lotId) external view returns (address) { return _lotAsset[lotId]; }
    function lotAmount(uint256 lotId) external view returns (uint256) { return _lotAmount[lotId]; }
    function escrowState(uint256 lotId) external view returns (EscrowState) { return _escrowState[lotId]; }
    function assetClaimed(uint256 lotId) external view returns (bool) { return _assetClaimed[lotId]; }
    function disputedAt(uint256 lotId) external view returns (uint256) { return _disputedAt[lotId]; }
    function evidenceCount(uint256 lotId, address party) external view returns (uint256) { return _evidenceCount[lotId][party]; }

    function isAssetAllowed(address asset) external view returns (bool allowed, Kind kind) {
        uint8 v = _allowedAssetKind[asset];
        if (v == 0) return (false, Kind.OFFCHAIN);
        return (true, Kind(v - 1));
    }

    // ─── Listing ─────────────────────────────────────────────────────────────────

    function list(
        Kind kind,
        address asset,
        uint256 id,
        uint256 amount,
        string calldata lotURI,
        uint256 reserve,
        uint256 durationSecs,
        uint256 minIncrement
    ) external nonReentrant {
        require(!paused, "AuctionHouse: paused");
        require(reserve <= maxReserve, "AuctionHouse: reserve too high");
        require(durationSecs > 0, "AuctionHouse: duration zero");
        require(minIncrement > 0, "AuctionHouse: min increment zero");

        if (kind != Kind.OFFCHAIN) {
            uint8 rawKind = _allowedAssetKind[asset];
            require(rawKind != 0, "AuctionHouse: asset not allowed");
            require(Kind(rawKind - 1) == kind, "AuctionHouse: asset kind mismatch");
        }

        uint256 bond = 0;
        if (kind == Kind.OFFCHAIN) {
            bond = reserve;
            if (reputationWriter != address(0) && reserve > 0) {
                try IReputationWriter(reputationWriter).cleanSalesView(msg.sender) returns (uint256 cs) {
                    if (cs >= 3) { bond = reserve / 2; }
                } catch {}
            }
        }

        uint256 lotId    = nextLotId;
        uint256 deadline = block.timestamp + durationSecs;
        nextLotId        = lotId + 1;

        lots[lotId] = Lot({
            seller:        msg.sender,
            tokenId:       0,
            reserve:       reserve,
            minIncrement:  minIncrement,
            bond:          bond,
            deadline:      deadline,
            highestBid:    0,
            highestBidder: address(0),
            extensions:    0,
            settledAt:     0,
            settled:       false,
            cancelled:     false,
            bondReleased:  kind != Kind.OFFCHAIN,
            disputed:      false
        });
        _lotKind[lotId]  = kind;

        if (kind == Kind.OFFCHAIN) {
            require(
                usdc.transferFrom(msg.sender, address(this), bond),
                "AuctionHouse: bond transfer failed"
            );
            uint256 tokenId = gavelLot.mint(address(lotVault), lotURI);
            lots[lotId].tokenId = tokenId;
            emit Listed(lotId, msg.sender, tokenId, reserve, deadline);

        } else if (kind == Kind.ERC721) {
            _lotAsset[lotId] = asset;
            _lotAmount[lotId] = 1;
            IERC721(asset).transferFrom(msg.sender, address(lotVault), id);
            require(IERC721(asset).ownerOf(id) == address(lotVault), "AuctionHouse: ERC721 transfer failed");
            lots[lotId].tokenId = id;
            emit Listed(lotId, msg.sender, id, reserve, deadline);

        } else if (kind == Kind.ERC1155) {
            require(amount > 0, "AuctionHouse: amount zero");
            _lotAsset[lotId] = asset;
            _lotAmount[lotId] = amount;
            lots[lotId].tokenId = id;
            lotVault.setExpectingDeposit(true);
            uint256 balBefore = IERC1155(asset).balanceOf(address(lotVault), id);
            IERC1155(asset).safeTransferFrom(msg.sender, address(lotVault), id, amount, "");
            lotVault.setExpectingDeposit(false);
            uint256 balAfter = IERC1155(asset).balanceOf(address(lotVault), id);
            require(balAfter - balBefore == amount, "AuctionHouse: ERC1155 transfer failed");
            emit Listed(lotId, msg.sender, id, reserve, deadline);

        } else { // ERC20
            require(amount > 0, "AuctionHouse: amount zero");
            _lotAsset[lotId] = asset;
            _lotAmount[lotId] = amount;
            lots[lotId].tokenId = 0;
            uint256 balBefore = IERC20(asset).balanceOf(address(lotVault));
            SafeERC20.safeTransferFrom(IERC20(asset), msg.sender, address(lotVault), amount);
            uint256 balAfter = IERC20(asset).balanceOf(address(lotVault));
            require(balAfter - balBefore == amount, "AuctionHouse: fee-on-transfer not supported");
            emit Listed(lotId, msg.sender, 0, reserve, deadline);
        }
    }

    // ─── Bidding ─────────────────────────────────────────────────────────────────

    /// @notice Direct bid. Draws from the bidder's claimable balance first (credit),
    ///         then pulls only the remainder from the bidder's USDC allowance.
    function bid(uint256 lotId, uint256 amount) external nonReentrant {
        require(!paused, "AuctionHouse: paused");
        // CEI: run _bidCore (which credits the previous leader) FIRST, so a
        // leader raising their own bid can immediately reuse the credit just returned.
        _bidCore(msg.sender, lotId, amount);

        uint256 credit = claimable[msg.sender] < amount ? claimable[msg.sender] : amount;
        if (credit > 0) {
            claimable[msg.sender] -= credit;
            emit CreditUsed(lotId, msg.sender, credit);
        }
        uint256 topUp = amount - credit;
        if (topUp > 0) {
            require(
                usdc.transferFrom(msg.sender, address(this), topUp),
                "AuctionHouse: bid transfer failed"
            );
        }
    }

    /// @notice Gasless bid. The bidder signs only the `topUp` portion.
    ///         `credit = amount - topUp` is deducted from `claimable[from]`.
    ///         `topUp == 0` reverts — credit-only bids must use direct `bid()`.
    function bidWithAuthorization(
        uint256 lotId,
        uint256 amount,
        uint256 topUp,
        address from,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 salt,
        uint8   v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        require(!paused, "AuctionHouse: paused");
        require(topUp > 0, "AuctionHouse: topUp must be nonzero");
        require(topUp <= amount, "AuctionHouse: topUp exceeds amount");
        uint256 credit = amount - topUp;

        // nonce binds contract, chainId, lotId, amount, topUp, and salt
        bytes32 nonce = keccak256(abi.encode(address(this), block.chainid, lotId, amount, topUp, salt));
        // CEI: credits previous leader first, so `from` can reuse their returned bid
        _bidCore(from, lotId, amount);
        // Check and deduct credit AFTER _bidCore credited the previous leader, so a
        // leader raising their own bid gaslessly can reuse the bid just returned.
        require(claimable[from] >= credit, "AuctionHouse: insufficient credit");
        if (credit > 0) {
            claimable[from] -= credit;
            emit CreditUsed(lotId, from, credit);
        }
        usdc.receiveWithAuthorization(from, address(this), topUp, validAfter, validBefore, nonce, v, r, s);
        emit RelayedBid(lotId, from, msg.sender, amount);
    }

    function _bidCore(address bidder, uint256 lotId, uint256 amount) internal {
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(!lot.settled && !lot.cancelled, "AuctionHouse: inactive lot");
        require(block.timestamp < lot.deadline, "AuctionHouse: auction ended");
        require(bidder != lot.seller, "AuctionHouse: seller cannot bid");
        require(amount > 0, "AuctionHouse: zero bid");

        if (lot.highestBid == 0) {
            require(amount >= lot.reserve, "AuctionHouse: below reserve");
        } else {
            require(amount >= lot.highestBid + lot.minIncrement, "AuctionHouse: increment too low");
        }

        address previousBidder = lot.highestBidder;
        uint256 previousBid    = lot.highestBid;

        lot.highestBid    = amount;
        lot.highestBidder = bidder;

        if (
            block.timestamp + SOFT_CLOSE_WINDOW > lot.deadline &&
            lot.extensions < MAX_EXTENSIONS
        ) {
            lot.deadline    = block.timestamp + SOFT_CLOSE_WINDOW;
            lot.extensions += 1;
            emit Extended(lotId, lot.deadline, lot.extensions);
        }

        if (previousBidder != address(0)) {
            claimable[previousBidder] += previousBid;
            emit Outbid(lotId, previousBidder, previousBid);
        }

        emit Bid(lotId, bidder, amount);
    }

    // ─── _payOut: push first, fallback to claimable ──────────────────────────────

    /// @dev Attempt a direct USDC push to `to`. If the transfer fails (e.g. blocklisted),
    ///      credit `claimable[to]` instead. State must already be set to terminal before
    ///      calling (all callers are nonReentrant and set EscrowState.CLOSED first).
    function _payOut(address to, uint256 amount) internal {
        if (amount == 0) return;
        bool pushed;
        try usdc.transfer(to, amount) returns (bool ok) {
            pushed = ok;
        } catch {
            pushed = false;
        }
        if (!pushed) {
            claimable[to] += amount;
        }
        emit PaidOut(to, amount, pushed);
    }

    // ─── Settle ──────────────────────────────────────────────────────────────────

    function settle(uint256 lotId) external nonReentrant {
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(block.timestamp >= lot.deadline, "AuctionHouse: not ended");
        require(!lot.settled && !lot.cancelled, "AuctionHouse: inactive lot");

        lot.settled = true;
        Kind kind   = _lotKind[lotId];

        if (lot.highestBidder != address(0)) {
            uint256 winningBid = lot.highestBid;
            lot.settledAt = block.timestamp;

            if (kind == Kind.OFFCHAIN) {
                _escrowState[lotId] = EscrowState.HELD;
                lotVault.releaseGavelLot(lot.highestBidder, lot.tokenId);
            } else {
                claimable[lot.seller] += winningBid;
            }

            emit Hammer(lotId, lot.highestBidder, winningBid);
            if (kind == Kind.OFFCHAIN) emit BondHeld(lotId, lot.bond);

        } else {
            if (kind == Kind.OFFCHAIN) {
                claimable[lot.seller] += lot.bond;
                lot.bondReleased = true;
            } else {
                lot.bondReleased = true;
            }
            emit Unsold(lotId, lot.seller);
        }
    }

    // ─── Asset claim ─────────────────────────────────────────────────────────────

    function claimLotAsset(uint256 lotId, address to) external nonReentrant {
        require(to != address(0), "AuctionHouse: zero recipient");
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(!_assetClaimed[lotId], "AuctionHouse: already claimed");

        Kind kind = _lotKind[lotId];
        bool isSold   = lot.settled && lot.highestBidder != address(0);
        bool isUnsold = (lot.settled || lot.cancelled) && lot.highestBidder == address(0);

        if (kind == Kind.OFFCHAIN) {
            require(isUnsold, "AuctionHouse: OFFCHAIN sold asset not claimable here");
            require(msg.sender == lot.seller, "AuctionHouse: not seller");
            _assetClaimed[lotId] = true;
            lotVault.releaseGavelLot(to, lot.tokenId);
        } else {
            if (isSold) {
                require(msg.sender == lot.highestBidder, "AuctionHouse: not winner");
            } else {
                require(isUnsold, "AuctionHouse: lot not concluded");
                require(msg.sender == lot.seller, "AuctionHouse: not seller");
            }
            _assetClaimed[lotId] = true;
            address asset  = _lotAsset[lotId];
            uint256 id     = lots[lotId].tokenId;
            uint256 amt    = _lotAmount[lotId];

            if (kind == Kind.ERC721) {
                lotVault.releaseERC721(asset, to, id);
            } else if (kind == Kind.ERC1155) {
                lotVault.releaseERC1155(asset, to, id, amt);
            } else {
                lotVault.releaseERC20(asset, to, amt);
            }
        }

        emit AssetClaimed(lotId, msg.sender, to);
    }

    // ─── OFFCHAIN escrow actions ─────────────────────────────────────────────────

    function confirmDelivery(uint256 lotId) external nonReentrant {
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(_lotKind[lotId] == Kind.OFFCHAIN, "AuctionHouse: not OFFCHAIN lot");
        require(msg.sender == lot.highestBidder, "AuctionHouse: not winner");
        require(lot.settled && lot.highestBidder != address(0), "AuctionHouse: not sold");
        require(!lot.bondReleased, "AuctionHouse: bond released");
        require(!lot.disputed, "AuctionHouse: disputed");
        require(_escrowState[lotId] == EscrowState.HELD, "AuctionHouse: escrow not held");

        _escrowState[lotId] = EscrowState.CLOSED;
        lot.bondReleased = true;
        _payOut(lot.seller, lot.highestBid + lot.bond);

        emit BondReleased(lotId, lot.seller, lot.bond);
    }

    function releaseEscrow(uint256 lotId) external nonReentrant {
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(_lotKind[lotId] == Kind.OFFCHAIN, "AuctionHouse: not OFFCHAIN lot");
        require(lot.settled && lot.highestBidder != address(0), "AuctionHouse: not sold");
        require(!lot.bondReleased, "AuctionHouse: bond released");
        require(_escrowState[lotId] == EscrowState.HELD, "AuctionHouse: escrow not held");
        require(
            block.timestamp >= lot.settledAt + DELIVERY_WINDOW,
            "AuctionHouse: delivery window open"
        );

        _escrowState[lotId] = EscrowState.CLOSED;
        lot.bondReleased = true;
        uint256 payment = lot.highestBid;
        _payOut(lot.seller, payment + lot.bond);

        emit EscrowReleased(lotId, lot.seller, payment);
        emit BondReleased(lotId, lot.seller, lot.bond);
    }

    /// @notice Refund the buyer with an optional reason. Callable by the seller.
    ///         Pushes payment directly to buyer's wallet (falls back to claimable if blocked).
    function refundBuyer(uint256 lotId, string calldata reason) external nonReentrant {
        require(bytes(reason).length <= MAX_REFUND_REASON_BYTES, "AuctionHouse: reason too long");
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(_lotKind[lotId] == Kind.OFFCHAIN, "AuctionHouse: not OFFCHAIN lot");
        require(msg.sender == lot.seller, "AuctionHouse: not seller");
        require(lot.settled && lot.highestBidder != address(0), "AuctionHouse: not sold");
        require(!lot.bondReleased, "AuctionHouse: bond released");
        require(_escrowState[lotId] == EscrowState.HELD, "AuctionHouse: escrow not held");

        _escrowState[lotId] = EscrowState.CLOSED;
        lot.bondReleased = true;
        address buyer = lot.highestBidder;
        uint256 payment = lot.highestBid;
        _payOut(buyer, payment);
        // Bond returns to seller (non-punitive refund; seller is calling voluntarily)
        _payOut(lot.seller, lot.bond);

        emit BuyerRefunded(lotId, buyer, payment, reason);
        emit BondReleased(lotId, lot.seller, lot.bond);
    }

    function dispute(uint256 lotId) external nonReentrant {
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(_lotKind[lotId] == Kind.OFFCHAIN, "AuctionHouse: not OFFCHAIN lot");
        require(msg.sender == lot.highestBidder, "AuctionHouse: not winner");
        require(lot.settled && lot.highestBidder != address(0), "AuctionHouse: not sold");
        require(!lot.bondReleased, "AuctionHouse: bond released");
        require(!lot.disputed, "AuctionHouse: disputed");
        require(_escrowState[lotId] == EscrowState.HELD, "AuctionHouse: escrow not held");
        require(
            block.timestamp < lot.settledAt + DELIVERY_WINDOW,
            "AuctionHouse: dispute window closed"
        );

        lot.disputed = true;
        _escrowState[lotId] = EscrowState.DISPUTED;
        _disputedAt[lotId] = block.timestamp;

        emit Disputed(lotId, msg.sender);
    }

    function resolveDispute(uint256 lotId, bool sellerAtFault) external nonReentrant onlyOwner {
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(lot.disputed, "AuctionHouse: not disputed");
        require(!lot.bondReleased, "AuctionHouse: bond released");
        require(_escrowState[lotId] == EscrowState.DISPUTED, "AuctionHouse: not disputed state");

        _escrowState[lotId] = EscrowState.CLOSED;
        lot.bondReleased = true;
        uint256 payment = lot.highestBid;

        if (sellerAtFault) {
            _payOut(lot.highestBidder, payment + lot.bond);
        } else {
            _payOut(lot.seller, payment + lot.bond);
        }

        emit DisputeResolved(lotId, sellerAtFault);
        emit BondReleased(lotId, sellerAtFault ? lot.highestBidder : lot.seller, lot.bond);
    }

    function resolveDisputeTimeout(uint256 lotId) external nonReentrant {
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(lot.disputed, "AuctionHouse: not disputed");
        require(!lot.bondReleased, "AuctionHouse: bond released");
        require(_escrowState[lotId] == EscrowState.DISPUTED, "AuctionHouse: not disputed state");
        require(
            block.timestamp >= _disputedAt[lotId] + DISPUTE_RESOLVE_TIMEOUT,
            "AuctionHouse: arbitration window open"
        );

        _escrowState[lotId] = EscrowState.CLOSED;
        lot.bondReleased = true;
        uint256 payment = lot.highestBid;
        uint256 buyerShare  = payment / 2;
        uint256 sellerShare = payment - buyerShare;

        _payOut(lot.highestBidder, buyerShare);
        _payOut(lot.seller, sellerShare + lot.bond);

        emit DisputeResolved(lotId, false);
        emit BondReleased(lotId, lot.seller, lot.bond);
    }

    // ─── Evidence ────────────────────────────────────────────────────────────────

    /// @notice Submit a short text evidence for an OFFCHAIN lot.
    ///         Only the buyer or the seller may call while escrow is HELD or DISPUTED.
    ///         At most MAX_EVIDENCE_PER_PARTY submissions per party per lot.
    function submitEvidence(uint256 lotId, string calldata text) external nonReentrant {
        require(bytes(text).length > 0, "AuctionHouse: empty evidence");
        require(bytes(text).length <= MAX_EVIDENCE_BYTES, "AuctionHouse: evidence too long");
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(_lotKind[lotId] == Kind.OFFCHAIN, "AuctionHouse: not OFFCHAIN lot");
        EscrowState es = _escrowState[lotId];
        require(es == EscrowState.HELD || es == EscrowState.DISPUTED, "AuctionHouse: escrow not active");
        require(
            msg.sender == lot.highestBidder || msg.sender == lot.seller,
            "AuctionHouse: not a party"
        );
        require(
            _evidenceCount[lotId][msg.sender] < MAX_EVIDENCE_PER_PARTY,
            "AuctionHouse: evidence limit reached"
        );
        _evidenceCount[lotId][msg.sender] += 1;
        emit Evidence(lotId, msg.sender, text);
    }

    // ─── Claim USDC ──────────────────────────────────────────────────────────────

    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        require(amount > 0, "AuctionHouse: nothing to claim");
        claimable[msg.sender] = 0;
        require(usdc.transfer(msg.sender, amount), "AuctionHouse: claim transfer failed");
        emit Claimed(msg.sender, amount);
    }

    // ─── Cancel ──────────────────────────────────────────────────────────────────

    function cancel(uint256 lotId) external nonReentrant {
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(msg.sender == lot.seller || msg.sender == owner(), "AuctionHouse: not authorized");
        require(lot.highestBid == 0, "AuctionHouse: already has bids");
        require(!lot.settled && !lot.cancelled, "AuctionHouse: inactive lot");

        address seller = lot.seller;
        Kind kind = _lotKind[lotId];

        lot.cancelled    = true;
        lot.bondReleased = true;

        if (kind == Kind.OFFCHAIN) {
            claimable[seller] += lot.bond;
        }

        emit Cancelled(lotId, seller);
    }
}
