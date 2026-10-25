// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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

/// @title AuctionHouse
/// @notice Live USDC auction house on Arc Testnet.
///         All amounts are in 6-decimal USDC units. No msg.value is used.
contract AuctionHouse is Ownable, ReentrancyGuard {
    // ─── Constants ──────────────────────────────────────────────────────────────
    uint256 public constant MAX_RESERVE       = 5_000_000; // 5 USDC (6 dec)
    uint256 public constant SOFT_CLOSE_WINDOW = 10;        // seconds before deadline to extend
    uint256 public constant MAX_EXTENSIONS    = 30;        // max soft-close extensions per lot
    uint256 public constant BOND_TIMEOUT           = 7 days;
    /// @dev If the owner has not resolved a dispute after this window, anyone may
    ///      trigger a seller-default resolution so bonds are never permanently locked.
    uint256 public constant DISPUTE_RESOLVE_TIMEOUT = 14 days;

    // ─── Lot storage ────────────────────────────────────────────────────────────
    struct Lot {
        address seller;
        uint256 tokenId;        // GavelLot ERC-721 tokenId held in LotVault
        uint256 reserve;        // minimum winning bid (USDC 6-dec)
        uint256 minIncrement;   // minimum increment over current highest bid
        uint256 bond;           // seller bond, set to reserve at list time
        uint256 deadline;       // block.timestamp at which bidding closes
        uint256 highestBid;     // current highest bid (USDC 6-dec)
        address highestBidder;
        uint256 extensions;     // number of soft-close extensions applied
        uint256 settledAt;      // settlement timestamp for sold lots
        bool    settled;
        bool    cancelled;
        bool    bondReleased;
        bool    disputed;
    }

    mapping(uint256 => Lot) public lots;
    uint256 public nextLotId;

    /// @notice Claimable USDC balances for outbid bidders and settled sellers.
    ///         Pull-pattern: we never push to a bidder address because Arc reverts
    ///         transfers to blocklisted addresses and one bad address must not
    ///         freeze the auction.
    mapping(address => uint256) public claimable;

    bool public paused;

    /// @notice Optional ReputationWriter; address(0) means not set.
    ///         If set, clean-sale count is checked to discount the seller bond.
    address public reputationWriter;

    // ─── Immutable trusted addresses ────────────────────────────────────────────
    GavelLot public immutable gavelLot;
    LotVault public immutable lotVault;
    /// @dev USDC on Arc Testnet. This contract is Arc-specific by design.
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

    // ─── Constructor ────────────────────────────────────────────────────────────
    constructor(address initialOwner) Ownable(msg.sender) {
        require(initialOwner != address(0), "AuctionHouse: zero owner");
        gavelLot = new GavelLot(address(this));
        lotVault = new LotVault(address(gavelLot), address(this));
        usdc = IUSDC3009(0x3600000000000000000000000000000000000000);
        transferOwnership(initialOwner);
    }

    // ─── Admin ──────────────────────────────────────────────────────────────────

    /// @dev Renouncing ownership is disabled — doing so while paused would
    ///      permanently prevent unpause and brick list/bid.
    function renounceOwnership() public override onlyOwner {
        revert("AuctionHouse: renounce disabled");
    }

    /// @notice Halt list() and bid(). settle() and claim() remain callable.
    function pause() external onlyOwner {
        paused = true;
    }

    /// @notice Resume normal operations.
    function unpause() external onlyOwner {
        paused = false;
    }

    /// @notice Set the ReputationWriter address. Only callable by owner.
    ///         Set to address(0) to disable reputation-based bond sizing.
    function setReputationWriter(address rw) external onlyOwner {
        emit ReputationWriterUpdated(reputationWriter, rw);
        reputationWriter = rw;
    }

    // ─── Core functions ─────────────────────────────────────────────────────────

    /// @notice List a lot for auction. Mints a GavelLot NFT and escrows it in
    ///         the LotVault. Pulls reserve-sized seller bond from the caller.
    /// @param lotURI        Metadata URI for the lot (becomes the GavelLot tokenURI).
    /// @param reserve       Minimum bid in USDC 6-dec units. Capped at MAX_RESERVE.
    /// @param durationSecs  Auction length in seconds. Must be > 0.
    /// @param minIncrement  Minimum bid increment in USDC 6-dec units.
    function list(
        string calldata lotURI,
        uint256 reserve,
        uint256 durationSecs,
        uint256 minIncrement
    ) external nonReentrant {
        require(!paused, "AuctionHouse: paused");
        require(reserve <= MAX_RESERVE, "AuctionHouse: reserve too high");
        require(durationSecs > 0, "AuctionHouse: duration zero");
        require(minIncrement > 0, "AuctionHouse: min increment zero");
        require(minIncrement <= 1_000_000, "AuctionHouse: min increment too high");

        // Bond is 100% of reserve by default.
        // If the seller has >= 3 clean sales per the ReputationWriter, bond is 50%.
        // Any failure in the reputation call defaults to 100% bond — never reverts list().
        uint256 bond = reserve;
        if (reputationWriter != address(0) && reserve > 0) {
            try IReputationWriter(reputationWriter).cleanSalesView(msg.sender) returns (uint256 cs) {
                if (cs >= 3) {
                    bond = reserve / 2;
                }
            } catch {}
        }

        // Assign lotId and advance counter before any external call (CEI).
        uint256 lotId    = nextLotId;
        uint256 deadline = block.timestamp + durationSecs;
        nextLotId        = lotId + 1;

        // Effects: write a placeholder that marks the slot occupied.
        // tokenId is filled in after the mint below; the lot is not yet valid
        // for bids because settled=false and deadline is in the future.
        lots[lotId] = Lot({
            seller:        msg.sender,
            tokenId:       0,           // set after mint
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
            bondReleased:  false,
            disputed:      false
        });

        // Interactions: pull bond, mint NFT to vault.
        require(
            usdc.transferFrom(msg.sender, address(this), bond),
            "AuctionHouse: bond transfer failed"
        );
        uint256 tokenId = gavelLot.mint(address(lotVault), lotURI);

        // Complete effects now that we have the tokenId.
        lots[lotId].tokenId = tokenId;

        emit Listed(lotId, msg.sender, tokenId, reserve, deadline);
    }

    /// @notice Place a bid. Pulls USDC from the caller. Credits any outbid
    ///         previous bidder to the claimable mapping (never transfers directly).
    /// @param lotId  ID of the lot to bid on.
    /// @param amount Bid amount in USDC 6-dec units.
    function bid(uint256 lotId, uint256 amount) external nonReentrant {
        require(!paused, "AuctionHouse: paused");
        _bidCore(msg.sender, lotId, amount);
        require(
            usdc.transferFrom(msg.sender, address(this), amount),
            "AuctionHouse: bid transfer failed"
        );
    }

    /// @notice Gasless bid via a single EIP-3009 ReceiveWithAuthorization signature.
    ///
    /// Security model: the nonce passed to USDC is computed as
    ///     keccak256(abi.encode(address(this), block.chainid, lotId, amount, salt))
    /// which binds every bid parameter and this contract's address into the nonce.
    /// USDC verifies the caller's signature over (from, to, amount, validAfter,
    /// validBefore, nonce), so a relayer cannot change lotId, amount, or chain
    /// without breaking the signature.  receiveWithAuthorization also enforces
    /// msg.sender == to, preventing replay as a plain ERC-3009 transfer.
    /// USDC's own used-nonce bitmap prevents replay of the same signature twice.
    ///
    /// @param lotId       Lot the bid is for.
    /// @param amount      Bid amount (USDC 6-dec).
    /// @param from        Bidder address (must be the EIP-3009 signer).
    /// @param validAfter  Signature not valid before this timestamp.
    /// @param validBefore Signature not valid after this timestamp.
    /// @param salt        Random value chosen by the signer to make the nonce unique.
    /// @param v           EIP-3009 signature component.
    /// @param r           EIP-3009 signature component.
    /// @param s           EIP-3009 signature component.
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

        // Bind lotId, amount, chainId, and this contract into the nonce so the
        // relayer cannot substitute a different lot or amount without invalidating
        // the bidder's signature.
        bytes32 nonce = keccak256(abi.encode(address(this), block.chainid, lotId, amount, salt));

        // Process bid state first (CEI: effects before interaction).
        _bidCore(from, lotId, amount);

        // Pull USDC from the signer.  USDC verifies the signature covers
        // (from, address(this), amount, validAfter, validBefore, nonce).
        usdc.receiveWithAuthorization(from, address(this), amount, validAfter, validBefore, nonce, v, r, s);

        emit RelayedBid(lotId, from, msg.sender, amount);
    }

    function _bidCore(address bidder, uint256 lotId, uint256 amount) internal {
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(!lot.settled && !lot.cancelled, "AuctionHouse: inactive lot");
        require(block.timestamp < lot.deadline, "AuctionHouse: auction ended");
        // Sellers cannot bid on their own lot (shill bidding), directly or relayed.
        require(bidder != lot.seller, "AuctionHouse: seller cannot bid");
        // A zero bid on a zero-reserve lot would win for free and block cancel().
        require(amount > 0, "AuctionHouse: zero bid");

        if (lot.highestBid == 0) {
            require(amount >= lot.reserve, "AuctionHouse: below reserve");
        } else {
            require(amount >= lot.highestBid + lot.minIncrement, "AuctionHouse: increment too low");
        }

        // Cache outbid state before mutating (CEI: effects first).
        address previousBidder = lot.highestBidder;
        uint256 previousBid    = lot.highestBid;

        // Effects: update lot state.
        lot.highestBid    = amount;
        lot.highestBidder = bidder;

        // Soft-close: extend deadline if within SOFT_CLOSE_WINDOW.
        if (
            block.timestamp + SOFT_CLOSE_WINDOW > lot.deadline &&
            lot.extensions < MAX_EXTENSIONS
        ) {
            lot.deadline    = block.timestamp + SOFT_CLOSE_WINDOW;
            lot.extensions += 1;
            emit Extended(lotId, lot.deadline, lot.extensions);
        }

        // Credit previous bidder to claimable (never direct transfer).
        if (previousBidder != address(0)) {
            claimable[previousBidder] += previousBid;
            emit Outbid(lotId, previousBidder, previousBid);
        }

        emit Bid(lotId, bidder, amount);
    }

    /// @notice Settle a concluded auction. Atomically transfers the lot NFT to
    ///         the winner and credits the seller with bid proceeds.
    ///         With no bids, returns both the NFT and the bond to the seller.
    /// @param lotId  ID of the lot to settle.
    function settle(uint256 lotId) external nonReentrant {
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(block.timestamp >= lot.deadline, "AuctionHouse: not ended");
        require(!lot.settled && !lot.cancelled, "AuctionHouse: inactive lot");

        // Effects first — mark settled before any external call.
        lot.settled = true;

        if (lot.highestBidder != address(0)) {
            address winner     = lot.highestBidder;
            uint256 winningBid = lot.highestBid;
            address seller     = lot.seller;

            // Effects: credit seller with bid proceeds only, hold bond.
            claimable[seller] += winningBid;
            lot.settledAt = block.timestamp;

            // Interaction: transfer NFT to winner.
            lotVault.release(winner, lot.tokenId);
            emit Hammer(lotId, winner, winningBid);
            emit BondHeld(lotId, lot.bond);
        } else {
            // No bids: return bond to seller immediately.
            address seller = lot.seller;
            claimable[seller] += lot.bond;
            lot.bondReleased = true;

            // Interaction: return NFT to seller.
            lotVault.release(seller, lot.tokenId);
            emit Unsold(lotId, seller);
        }
    }

    /// @notice Confirm delivery by the winner and release seller bond.
    function confirmDelivery(uint256 lotId) external nonReentrant {
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(msg.sender == lot.highestBidder, "AuctionHouse: not winner");
        require(lot.settled && lot.highestBidder != address(0), "AuctionHouse: not sold");
        require(!lot.bondReleased, "AuctionHouse: bond released");
        require(!lot.disputed, "AuctionHouse: disputed");

        lot.bondReleased = true;
        claimable[lot.seller] += lot.bond;

        emit BondReleased(lotId, lot.seller, lot.bond);
    }

    /// @notice Release seller bond after timeout if no dispute was raised.
    function releaseBondAfterTimeout(uint256 lotId) external nonReentrant {
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(lot.settled && lot.highestBidder != address(0), "AuctionHouse: not sold");
        require(!lot.bondReleased, "AuctionHouse: bond released");
        require(!lot.disputed, "AuctionHouse: disputed");
        require(block.timestamp >= lot.settledAt + BOND_TIMEOUT, "AuctionHouse: bond timeout");

        lot.bondReleased = true;
        claimable[lot.seller] += lot.bond;

        emit BondReleased(lotId, lot.seller, lot.bond);
    }

    /// @notice Raise a dispute before bond timeout.
    function dispute(uint256 lotId) external nonReentrant {
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(msg.sender == lot.highestBidder, "AuctionHouse: not winner");
        require(lot.settled && lot.highestBidder != address(0), "AuctionHouse: not sold");
        require(!lot.bondReleased, "AuctionHouse: bond released");
        require(!lot.disputed, "AuctionHouse: disputed");
        require(block.timestamp < lot.settledAt + BOND_TIMEOUT, "AuctionHouse: dispute window closed");

        lot.disputed = true;

        emit Disputed(lotId, msg.sender);
    }

    /// @notice Resolve a dispute and release bond to winner (seller fault) or seller.
    function resolveDispute(uint256 lotId, bool sellerAtFault) external nonReentrant onlyOwner {
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(lot.disputed, "AuctionHouse: not disputed");
        require(!lot.bondReleased, "AuctionHouse: bond released");

        lot.bondReleased = true;

        address recipient;
        if (sellerAtFault) {
            recipient = lot.highestBidder;
        } else {
            recipient = lot.seller;
        }

        claimable[recipient] += lot.bond;

        emit DisputeResolved(lotId, sellerAtFault);
        emit BondReleased(lotId, recipient, lot.bond);
    }

    /// @notice Permissionless fallback: if the owner has not resolved a dispute
    ///         within DISPUTE_RESOLVE_TIMEOUT, anyone may call this to release
    ///         the bond to the seller. Prevents bonds from being locked forever.
    function resolveDisputeTimeout(uint256 lotId) external nonReentrant {
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(lot.disputed, "AuctionHouse: not disputed");
        require(!lot.bondReleased, "AuctionHouse: bond released");
        require(
            block.timestamp >= lot.settledAt + DISPUTE_RESOLVE_TIMEOUT,
            "AuctionHouse: arbitration window open"
        );

        lot.bondReleased = true;
        claimable[lot.seller] += lot.bond;

        emit DisputeResolved(lotId, false); // false = seller not at fault (timeout default)
        emit BondReleased(lotId, lot.seller, lot.bond);
    }

    /// @notice Withdraw the caller's full claimable USDC balance.
    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        require(amount > 0, "AuctionHouse: nothing to claim");

        // Effects before interaction (CEI).
        claimable[msg.sender] = 0;

        // Interaction: send USDC.
        require(
            usdc.transfer(msg.sender, amount),
            "AuctionHouse: claim transfer failed"
        );

        emit Claimed(msg.sender, amount);
    }

    /// @notice Cancel a lot that has received no bids. Returns the NFT and bond
    ///         to the seller. Only callable by the seller or the contract owner.
    /// @param lotId  ID of the lot to cancel.
    function cancel(uint256 lotId) external nonReentrant {
        Lot storage lot = lots[lotId];
        require(lot.seller != address(0), "AuctionHouse: invalid lot");
        require(msg.sender == lot.seller || msg.sender == owner(), "AuctionHouse: not authorized");
        require(lot.highestBid == 0, "AuctionHouse: already has bids");
        require(!lot.settled && !lot.cancelled, "AuctionHouse: inactive lot");

        address seller = lot.seller;
        uint256 tokenId = lot.tokenId;

        // Effects: mark cancelled and credit bond before external call.
        lot.cancelled = true;
        lot.bondReleased = true;
        claimable[seller] += lot.bond;

        // Interaction: return NFT.
        lotVault.release(seller, tokenId);

        emit Cancelled(lotId, seller);
    }
}
