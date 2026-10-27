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

/// @title AuctionHouse v7
/// @notice Live USDC auction house on Arc. Supports off-chain lots and on-chain
///         asset lots (ERC721, ERC1155, ERC20). All USDC amounts in 6-decimal units.
contract AuctionHouse is Ownable, ReentrancyGuard {

    // ─── Lot kind ────────────────────────────────────────────────────────────────
    enum Kind { OFFCHAIN, ERC721, ERC1155, ERC20 }

    // ─── OFFCHAIN escrow state ───────────────────────────────────────────────────
    enum EscrowState { NONE, HELD, DISPUTED, CLOSED }

    // ─── Constants ──────────────────────────────────────────────────────────────
    /// @notice Default max reserve. Owner may raise up to MAX_RESERVE_CAP.
    uint256 public constant MAX_RESERVE_CAP   = 100_000_000_000; // 100,000 USDC hard cap
    uint256 public constant SOFT_CLOSE_WINDOW = 10;
    uint256 public constant MAX_EXTENSIONS    = 500;
    uint256 public constant DELIVERY_WINDOW   = 7 days;
    uint256 public constant DISPUTE_RESOLVE_TIMEOUT = 14 days;

    /// @notice Owner-adjustable reserve cap, default 1,000 USDC.
    uint256 public maxReserve = 1_000_000_000; // 1,000 USDC (6 dec)

    // ─── Allowlist ───────────────────────────────────────────────────────────────
    /// @notice Allowed asset address -> its Kind (for non-OFFCHAIN lots).
    ///         Stored as uint8 (Kind enum value) + 1; 0 means not allowed.
    mapping(address => uint8) internal _allowedAssetKind; // 0=not allowed, else Kind+1

    // ─── Lot storage ────────────────────────────────────────────────────────────
    struct Lot {
        address seller;
        uint256 tokenId;        // GavelLot ERC-721 tokenId (OFFCHAIN) or asset token ID
        uint256 reserve;
        uint256 minIncrement;
        uint256 bond;           // seller bond (OFFCHAIN only; 0 for on-chain kinds)
        uint256 deadline;
        uint256 highestBid;
        address highestBidder;
        uint256 extensions;
        uint256 settledAt;
        bool    settled;
        bool    cancelled;
        bool    bondReleased;   // OFFCHAIN: bond released; on-chain kinds: always true
        bool    disputed;       // OFFCHAIN only
    }

    mapping(uint256 => Lot)         public lots;
    mapping(uint256 => Kind)        internal _lotKind;
    mapping(uint256 => address)     internal _lotAsset;    // ERC721/1155/20 asset address
    mapping(uint256 => uint256)     internal _lotAmount;   // ERC20/ERC1155 amount
    mapping(uint256 => EscrowState) internal _escrowState; // OFFCHAIN only
    mapping(uint256 => bool)        internal _assetClaimed;// T4 double-claim guard
    mapping(uint256 => uint256)     internal _disputedAt;  // arbitration timeout starts here

    uint256 public nextLotId;

    mapping(address => uint256) public claimable;

    bool public paused;
    address public reputationWriter;

    // ─── Immutable trusted addresses ────────────────────────────────────────────
    GavelLot public immutable gavelLot;
    LotVault public immutable lotVault;
    IUSDC3009 public immutable usdc;

    // ─── Events ─────────────────────────────────────────────────────────────────
    event Listed(uint256 indexed lotId, address indexed seller, uint256 tokenId, uint256 reserve, uint256 deadline);
    event Bid(uint256 indexed lotId, address indexed bidder, uint256 amount);
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
    event BuyerRefunded(uint256 indexed lotId, address indexed buyer, uint256 amount);
    event AllowedAssetSet(address indexed asset, Kind kind, bool allowed);
    event MaxReserveSet(uint256 newMaxReserve);

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

    /// @notice Set or remove an asset from the allowlist.
    /// @param asset The ERC token contract address.
    /// @param kind  The Kind it is allowed as (ERC721, ERC1155, ERC20).
    /// @param allow True to add, false to remove.
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

    /// @notice Owner-adjustable max reserve. Cannot exceed MAX_RESERVE_CAP.
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

    function isAssetAllowed(address asset) external view returns (bool allowed, Kind kind) {
        uint8 v = _allowedAssetKind[asset];
        if (v == 0) return (false, Kind.OFFCHAIN);
        return (true, Kind(v - 1));
    }

    // ─── Listing ─────────────────────────────────────────────────────────────────

    /// @notice List a lot for auction.
    /// @param kind          OFFCHAIN, ERC721, ERC1155, or ERC20.
    /// @param asset         For non-OFFCHAIN: the token contract address (must be allowlisted).
    ///                      For OFFCHAIN: ignored (pass address(0)).
    /// @param id            Token ID for ERC721/ERC1155. Ignored for OFFCHAIN/ERC20.
    /// @param amount        For ERC20/ERC1155: the amount to escrow. Ignored for others.
    /// @param lotURI        Metadata URI for the lot.
    /// @param reserve       Minimum bid in USDC 6-dec units. Capped at maxReserve.
    /// @param durationSecs  Auction length in seconds. Must be > 0.
    /// @param minIncrement  Minimum bid increment. Must be > 0.
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

        // Validate asset allowlist for non-OFFCHAIN kinds.
        if (kind != Kind.OFFCHAIN) {
            uint8 rawKind = _allowedAssetKind[asset];
            require(rawKind != 0, "AuctionHouse: asset not allowed");
            require(Kind(rawKind - 1) == kind, "AuctionHouse: asset kind mismatch");
        }

        // Bond: OFFCHAIN uses reserve-based bond; on-chain kinds use no bond.
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
            bondReleased:  kind != Kind.OFFCHAIN, // on-chain kinds: no bond to track
            disputed:      false
        });
        _lotKind[lotId]  = kind;

        // Pull assets and bond.
        if (kind == Kind.OFFCHAIN) {
            // Pull USDC bond.
            require(
                usdc.transferFrom(msg.sender, address(this), bond),
                "AuctionHouse: bond transfer failed"
            );
            // Mint GavelLot NFT to vault.
            uint256 tokenId = gavelLot.mint(address(lotVault), lotURI);
            lots[lotId].tokenId = tokenId;
            emit Listed(lotId, msg.sender, tokenId, reserve, deadline);

        } else if (kind == Kind.ERC721) {
            _lotAsset[lotId] = asset;
            _lotAmount[lotId] = 1;
            // Pull NFT into vault. ownerOf check confirms success.
            IERC721(asset).transferFrom(msg.sender, address(lotVault), id);
            require(IERC721(asset).ownerOf(id) == address(lotVault), "AuctionHouse: ERC721 transfer failed");
            lots[lotId].tokenId = id;
            // Pull USDC bond (0 for non-OFFCHAIN).
            emit Listed(lotId, msg.sender, id, reserve, deadline);

        } else if (kind == Kind.ERC1155) {
            require(amount > 0, "AuctionHouse: amount zero");
            _lotAsset[lotId] = asset;
            _lotAmount[lotId] = amount;
            lots[lotId].tokenId = id;
            // Signal vault to accept the incoming transfer.
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

    function bid(uint256 lotId, uint256 amount) external nonReentrant {
        require(!paused, "AuctionHouse: paused");
        _bidCore(msg.sender, lotId, amount);
        require(
            usdc.transferFrom(msg.sender, address(this), amount),
            "AuctionHouse: bid transfer failed"
        );
    }

    function bidWithAuthorization(
        uint256 lotId,
        uint256 amount,
        address from,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 salt,
        uint8   v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        require(!paused, "AuctionHouse: paused");
        bytes32 nonce = keccak256(abi.encode(address(this), block.chainid, lotId, amount, salt));
        _bidCore(from, lotId, amount);
        usdc.receiveWithAuthorization(from, address(this), amount, validAfter, validBefore, nonce, v, r, s);
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
                // Payment goes into escrow; the GavelLot NFT goes to the winner.
                _escrowState[lotId] = EscrowState.HELD;
                // Do NOT credit seller yet — payment is held in escrow.
                lotVault.releaseGavelLot(lot.highestBidder, lot.tokenId);
            } else {
                // On-chain asset: seller is credited immediately; winner gets an asset claim.
                claimable[lot.seller] += winningBid;
            }

            emit Hammer(lotId, lot.highestBidder, winningBid);
            if (kind == Kind.OFFCHAIN) emit BondHeld(lotId, lot.bond);

        } else {
            // No bids.
            if (kind == Kind.OFFCHAIN) {
                // Return bond to seller's claimable.
                // GavelLot NFT stays in vault; seller calls claimLotAsset() to retrieve it.
                claimable[lot.seller] += lot.bond;
                lot.bondReleased = true;
            } else {
                // Asset stays in vault; seller calls claimLotAsset() to retrieve it.
                lot.bondReleased = true;
            }
            emit Unsold(lotId, lot.seller);
        }
    }

    // ─── Asset claim ─────────────────────────────────────────────────────────────

    /// @notice Claim the lot's on-chain asset (or GavelLot NFT for OFFCHAIN unsold/cancelled)
    ///         to any address the entitled party chooses.
    /// @param lotId  The lot.
    /// @param to     Destination address for the asset.
    function claimLotAsset(uint256 lotId, address to) external nonReentrant {
        require(to != address(0), "AuctionHouse: zero recipient");
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(!_assetClaimed[lotId], "AuctionHouse: already claimed");

        Kind kind = _lotKind[lotId];

        // Determine entitlement.
        // For OFFCHAIN: this function is for the GavelLot NFT when the lot is unsold/cancelled.
        //               When sold, the NFT went to the winner directly in settle().
        // For ERC721/ERC1155/ERC20: winner claims after settle, or seller after unsold settle/cancel.
        bool isSold = lot.settled && lot.highestBidder != address(0);
        bool isUnsold = (lot.settled || lot.cancelled) && lot.highestBidder == address(0);

        if (kind == Kind.OFFCHAIN) {
            // OFFCHAIN sold lots: NFT was already sent to winner in settle(); nothing left.
            // OFFCHAIN unsold/cancelled: seller claims the NFT.
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
                // ERC20
                lotVault.releaseERC20(asset, to, amt);
            }
        }

        emit AssetClaimed(lotId, msg.sender, to);
    }

    // ─── OFFCHAIN escrow actions ─────────────────────────────────────────────────

    /// @notice Confirm delivery of an OFFCHAIN lot. Releases payment to seller and bond.
    ///         Only callable by the winner.
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
        claimable[lot.seller] += lot.highestBid + lot.bond;

        emit BondReleased(lotId, lot.seller, lot.bond);
    }

    /// @notice Release escrow payment to the seller after the delivery window with no dispute.
    ///         Permissionless — anyone may call after 7 days with no dispute.
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
        claimable[lot.seller] += payment + lot.bond;

        emit EscrowReleased(lotId, lot.seller, payment);
        emit BondReleased(lotId, lot.seller, lot.bond);
    }

    /// @notice Refund the buyer. Callable by the seller at any time before escrow is closed.
    ///         Returns the payment to the buyer and the bond to the seller.
    function refundBuyer(uint256 lotId) external nonReentrant {
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
        claimable[buyer]      += payment;
        claimable[lot.seller] += lot.bond;

        emit BuyerRefunded(lotId, buyer, payment);
        emit BondReleased(lotId, lot.seller, lot.bond);
    }

    /// @notice Raise a dispute within the delivery window.
    ///         Only callable by the winner of an OFFCHAIN lot.
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

    /// @notice Resolve a dispute. Callable by the owner.
    ///         If seller at fault: buyer receives payment + bond.
    ///         If seller not at fault: seller receives payment + bond.
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
            // Buyer gets payment + bond.
            claimable[lot.highestBidder] += payment + lot.bond;
        } else {
            // Seller gets payment + bond.
            claimable[lot.seller] += payment + lot.bond;
        }

        emit DisputeResolved(lotId, sellerAtFault);
        emit BondReleased(lotId, sellerAtFault ? lot.highestBidder : lot.seller, lot.bond);
    }

    /// @notice Permissionless timeout: 14 days after the dispute was opened, split 50/50.
    ///         Buyer gets floor(payment/2); seller gets the rest + bond.
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
        uint256 sellerShare = payment - buyerShare; // handles odd amounts: seller gets the extra

        claimable[lot.highestBidder] += buyerShare;
        claimable[lot.seller]        += sellerShare + lot.bond;

        emit DisputeResolved(lotId, false);
        emit BondReleased(lotId, lot.seller, lot.bond);
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
            // Bond back to seller. GavelLot NFT stays in vault; seller uses claimLotAsset().
            claimable[seller] += lot.bond;
        }
        // On-chain assets: vault still holds the token; seller uses claimLotAsset().

        emit Cancelled(lotId, seller);
    }
}
