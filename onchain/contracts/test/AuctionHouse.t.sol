// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {AuctionHouse} from "../AuctionHouse.sol";
import {GavelLot}     from "../GavelLot.sol";
import {MockUSDC}     from "../test-helpers/MockUSDC.sol";
import {ITransferHook} from "../test-helpers/MockUSDC.sol";
import {ReputationWriter}        from "../ReputationWriter.sol";
import {MockIdentityRegistry}    from "../test-helpers/MockIdentityRegistry.sol";
import {MockReputationRegistry}  from "../test-helpers/MockReputationRegistry.sol";
import {MockReputationWriter}    from "../test-helpers/MockReputationWriter.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Reentrancy attacker (Test 16)
// ─────────────────────────────────────────────────────────────────────────────
contract ReentrancyAttacker is ITransferHook {
    AuctionHouse public house;
    bool public reentered;
    bool public reentryReverted;

    constructor(AuctionHouse _house) {
        house = _house;
    }

    // Called by MockUSDC.transfer() after the first claim pays out.
    function onTransfer(address /*to*/, uint256 /*amount*/) external override {
        reentered = true;
        // Attempt a second claim — should revert with ReentrancyGuard.
        try house.claim() {
            reentryReverted = false;
        } catch {
            reentryReverted = true;
        }
    }

    // Allow this contract to be funded via MockUSDC.mint and to call claim().
    function doClaim() external {
        house.claim();
    }
}

contract NFTRejecter {
    // No onERC721Received: a safeTransferFrom to this contract would revert.
}

// ─────────────────────────────────────────────────────────────────────────────
// Main test contract
// ─────────────────────────────────────────────────────────────────────────────
contract AuctionHouseTest is Test {
    // ── Addresses ──────────────────────────────────────────────────────────────
    address internal constant USDC_ADDR = 0x3600000000000000000000000000000000000000;

    AuctionHouse internal house;
    MockUSDC     internal usdc;
    GavelLot     internal gavelLot;

    address internal seller  = makeAddr("seller");
    address internal alice   = makeAddr("alice");
    address internal bob     = makeAddr("bob");
    address internal carol   = makeAddr("carol");
    address internal dave    = makeAddr("dave");

    // Constants mirrored from AuctionHouse.
    uint256 internal constant SOFT_CLOSE_WINDOW       = 10;
    uint256 internal constant MAX_EXTENSIONS          = 30;
    uint256 internal constant BOND_TIMEOUT            = 7 days;
    uint256 internal constant DISPUTE_RESOLVE_TIMEOUT = 14 days;

    // ── setUp ──────────────────────────────────────────────────────────────────
    function setUp() public {
        // 1. Deploy MockUSDC and etch its bytecode at the canonical USDC address.
        MockUSDC mock = new MockUSDC();
        vm.etch(USDC_ADDR, address(mock).code);
        usdc = MockUSDC(USDC_ADDR);

        // 2. Deploy AuctionHouse; address(this) is owner.
        house    = new AuctionHouse(address(this));
        gavelLot = house.gavelLot();
    }

    // ── Lot struct field getters ───────────────────────────────────────────────
    // The Lot struct fields in order (0-indexed):
    //  0  seller
    //  1  tokenId
    //  2  reserve
    //  3  minIncrement
    //  4  bond
    //  5  deadline
    //  6  highestBid
    //  7  highestBidder
    //  8  extensions
    //  9  settledAt
    // 10  settled
    // 11  cancelled
    // 12  bondReleased
    // 13  disputed

    function _lotSeller(uint256 id)       internal view returns (address v) { (v,,,,,,,,,,,,,) = house.lots(id); }
    function _lotTokenId(uint256 id)      internal view returns (uint256 v) { (,v,,,,,,,,,,,,) = house.lots(id); }
    function _lotReserve(uint256 id)      internal view returns (uint256 v) { (,,v,,,,,,,,,,,) = house.lots(id); }
    function _lotMinIncrement(uint256 id) internal view returns (uint256 v) { (,,,v,,,,,,,,,,) = house.lots(id); }
    function _lotBond(uint256 id)         internal view returns (uint256 v) { (,,,,v,,,,,,,,,) = house.lots(id); }
    function _lotDeadline(uint256 id)     internal view returns (uint256 v) { (,,,,,v,,,,,,,,) = house.lots(id); }
    function _lotHighestBid(uint256 id)   internal view returns (uint256 v) { (,,,,,,v,,,,,,,) = house.lots(id); }
    function _lotHighestBidder(uint256 id)internal view returns (address v) { (,,,,,,,v,,,,,,) = house.lots(id); }
    function _lotExtensions(uint256 id)   internal view returns (uint256 v) { (,,,,,,,,v,,,,,) = house.lots(id); }
    function _lotSettledAt(uint256 id)    internal view returns (uint256 v) { (,,,,,,,,,v,,,,) = house.lots(id); }
    function _lotSettled(uint256 id)      internal view returns (bool    v) { (,,,,,,,,,,v,,,) = house.lots(id); }
    function _lotCancelled(uint256 id)    internal view returns (bool    v) { (,,,,,,,,,,,v,,) = house.lots(id); }
    function _lotBondReleased(uint256 id) internal view returns (bool    v) { (,,,,,,,,,,,,v,) = house.lots(id); }
    function _lotDisputed(uint256 id)     internal view returns (bool    v) { (,,,,,,,,,,,,,v) = house.lots(id); }

    // ── Core helpers ───────────────────────────────────────────────────────────

    /// @dev Mint bond USDC to seller, approve, and call house.list().
    function _list(
        address _seller,
        uint256 reserve,
        uint256 minIncrement,
        uint256 duration
    ) internal returns (uint256 lotId) {
        lotId = house.nextLotId();
        usdc.mint(_seller, reserve); // bond == reserve
        vm.startPrank(_seller);
        usdc.approve(address(house), reserve);
        house.list("ipfs://test", reserve, duration, minIncrement);
        vm.stopPrank();
    }

    /// @dev Mint USDC to bidder, approve, and call house.bid().
    function _bid(address bidder, uint256 lotId, uint256 amount) internal {
        usdc.mint(bidder, amount);
        vm.startPrank(bidder);
        usdc.approve(address(house), amount);
        house.bid(lotId, amount);
        vm.stopPrank();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 1 — Happy path: list, three bids, settle
    // ══════════════════════════════════════════════════════════════════════════
    function test_01_HappyPath_ListBidSettle() public {
        uint256 lotId = _list(seller, 2_000_000, 500_000, 3600);

        _bid(alice, lotId,  2_000_000);
        _bid(bob,   lotId,  2_500_000);
        _bid(carol, lotId,  3_000_000);

        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);

        // Winner (carol) holds the NFT.
        assertEq(gavelLot.ownerOf(_lotTokenId(lotId)), carol, "carol should own NFT");

        // Seller credited with winning bid.
        assertEq(house.claimable(seller), 3_000_000, "seller claimable");

        // Bond NOT released yet.
        assertFalse(_lotBondReleased(lotId), "bond should still be held");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 2 — Soft close: bid within window extends deadline
    // ══════════════════════════════════════════════════════════════════════════
    function test_02_SoftClose_ExtendDeadline() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 300);

        uint256 deadlineBefore = _lotDeadline(lotId);

        // Warp to 3 seconds before deadline (within SOFT_CLOSE_WINDOW = 10).
        vm.warp(deadlineBefore - 3);

        _bid(alice, lotId, 1_000_000);

        uint256 deadlineAfter = _lotDeadline(lotId);
        uint256 ext           = _lotExtensions(lotId);

        // New deadline should be block.timestamp + SOFT_CLOSE_WINDOW.
        assertEq(deadlineAfter, block.timestamp + SOFT_CLOSE_WINDOW, "deadline after soft close");
        assertEq(ext, 1, "extensions should be 1");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 3 — MAX_EXTENSIONS cap: 31st bid does not extend further
    // ══════════════════════════════════════════════════════════════════════════
    function test_03_MaxExtensions_Cap() public {
        uint256 lotId = _list(seller, 1_000_000, 10_000, 300);

        uint256 bidAmount = 1_000_000;

        // 30 bids each within the SOFT_CLOSE_WINDOW.
        for (uint256 i = 0; i < MAX_EXTENSIONS; i++) {
            vm.warp(_lotDeadline(lotId) - 3); // within soft-close window
            bidAmount += 10_000;
            address bidder = address(uint160(0xBEEF0000 + i));
            _bid(bidder, lotId, bidAmount);
        }

        // Confirm 30 extensions.
        assertEq(_lotExtensions(lotId), MAX_EXTENSIONS, "should have 30 extensions");

        // 31st bid: warp to deadline-3 again — deadline must NOT move.
        uint256 dlAt30          = _lotDeadline(lotId);
        uint256 expectedDeadline = dlAt30; // should stay unchanged
        vm.warp(dlAt30 - 3);

        bidAmount += 10_000;
        address lastBidder = address(uint160(0xBEEF0000 + MAX_EXTENSIONS));
        _bid(lastBidder, lotId, bidAmount);

        assertEq(_lotExtensions(lotId), MAX_EXTENSIONS, "extensions should remain 30");
        assertEq(_lotDeadline(lotId),   expectedDeadline, "deadline should NOT extend");

        // Warp past the non-extended deadline and settle.
        vm.warp(expectedDeadline + 1);
        house.settle(lotId);

        assertEq(gavelLot.ownerOf(_lotTokenId(lotId)), lastBidder, "last bidder wins");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 4 — 20 consecutive late bids extend correctly, settle cleanly
    // ══════════════════════════════════════════════════════════════════════════
    function test_04_TwentyLateBids_ExtendAndSettle() public {
        uint256 lotId = _list(seller, 1_000_000, 10_000, 300);

        uint256 bidAmount = 1_000_000;
        address lastBidder;

        for (uint256 i = 0; i < 20; i++) {
            vm.warp(_lotDeadline(lotId) - 3);
            bidAmount += 10_000;
            lastBidder = address(uint160(0xCAFE0000 + i));
            _bid(lastBidder, lotId, bidAmount);

            assertEq(_lotExtensions(lotId), i + 1, "extension count");
        }

        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);

        assertEq(house.claimable(seller), bidAmount, "seller credited with winning bid");
        assertEq(gavelLot.ownerOf(_lotTokenId(lotId)), lastBidder, "last bidder wins");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 5 — Revert: below reserve, below increment
    // ══════════════════════════════════════════════════════════════════════════
    function test_05_RevertBelowReserveAndIncrement() public {
        uint256 lotId = _list(seller, 1_000_000, 500_000, 3600);

        // Bid below reserve.
        usdc.mint(alice, 500_000);
        vm.startPrank(alice);
        usdc.approve(address(house), 500_000);
        vm.expectRevert("AuctionHouse: below reserve");
        house.bid(lotId, 500_000);
        vm.stopPrank();

        // First valid bid.
        _bid(alice, lotId, 1_000_000);

        // Second bid below increment (need >= 1_000_000 + 500_000 = 1_500_000).
        usdc.mint(bob, 1_000_000);
        vm.startPrank(bob);
        usdc.approve(address(house), 1_000_000);
        vm.expectRevert("AuctionHouse: increment too low");
        house.bid(lotId, 1_000_000);
        vm.stopPrank();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 6 — Bid after deadline reverts
    // ══════════════════════════════════════════════════════════════════════════
    function test_06_BidAfterDeadlineReverts() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 300);

        vm.warp(_lotDeadline(lotId) + 1);

        usdc.mint(alice, 1_000_000);
        vm.startPrank(alice);
        usdc.approve(address(house), 1_000_000);
        vm.expectRevert("AuctionHouse: auction ended");
        house.bid(lotId, 1_000_000);
        vm.stopPrank();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 7 — Previous bidder claimable rises in same tx as outbid
    // ══════════════════════════════════════════════════════════════════════════
    function test_07_OutbidCreditsClaimableAtomically() public {
        uint256 lotId = _list(seller, 1_000_000, 500_000, 3600);

        _bid(alice, lotId, 1_000_000);
        assertEq(house.claimable(alice), 0, "before outbid: alice claimable 0");

        _bid(bob, lotId, 1_500_000);

        // After bob's single bid call, alice's claimable is immediately 1_000_000.
        assertEq(house.claimable(alice), 1_000_000, "alice claimable after outbid");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 8 — Blocklisted address cannot block other bidders/settlement
    // ══════════════════════════════════════════════════════════════════════════
    function test_08_BlocklistedAddressCannotBlockOthers() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 3600);

        // Alice bids first.
        _bid(alice, lotId, 1_000_000);

        // Blocklist alice (transfer TO alice returns false, not revert).
        usdc.blocklist(alice);

        // Bob outbids alice — must succeed even though alice is blocklisted.
        // Alice's refund goes to claimable (pull-pattern), no direct transfer.
        _bid(bob, lotId, 1_100_000);
        assertEq(house.claimable(alice), 1_000_000, "alice claimable after outbid");

        // Carol outbids bob.
        _bid(carol, lotId, 1_200_000);

        // Settle.
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);

        // Bob (not blocklisted) can claim.
        uint256 bobClaimable = house.claimable(bob);
        assertGt(bobClaimable, 0, "bob should have claimable");
        vm.prank(bob);
        house.claim();
        assertEq(house.claimable(bob), 0, "bob claimed");

        // Alice (blocklisted) tries to claim — transfer TO alice returns false.
        assertEq(house.claimable(alice), 1_000_000, "alice still has claimable");
        vm.prank(alice);
        vm.expectRevert("AuctionHouse: claim transfer failed");
        house.claim();

        // Alice's claim revert doesn't affect contract state for others.
        assertEq(house.claimable(bob), 0, "bob unaffected");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 9 — Settle with no bids: NFT and bond returned to seller
    // ══════════════════════════════════════════════════════════════════════════
    function test_09_SettleNoBids_ReturnsBondAndNFT() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 300);

        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);

        // Bond released flag.
        assertTrue(_lotBondReleased(lotId), "bond released after unsold");

        // Bond (== reserve == 1_000_000) credited to seller.
        assertEq(house.claimable(seller), 1_000_000, "seller claimable == bond");

        // NFT returned to seller.
        assertEq(gavelLot.ownerOf(_lotTokenId(lotId)), seller, "seller owns NFT after unsold");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 10 — Double settle reverts
    // ══════════════════════════════════════════════════════════════════════════
    function test_10_DoubleSettleReverts() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, lotId, 1_000_000);

        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);

        vm.expectRevert("AuctionHouse: inactive lot");
        house.settle(lotId);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 11 — Atomicity: NFT transfer and seller credit in same settle() call
    // ══════════════════════════════════════════════════════════════════════════
    function test_11_SettleAtomicity_NFTAndCreditSameTx() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, lotId, 1_000_000);

        vm.warp(_lotDeadline(lotId) + 1);

        // Before settle: seller has 0 claimable, vault holds the NFT.
        uint256 tokenId = _lotTokenId(lotId);
        assertEq(house.claimable(seller), 0, "before: seller claimable 0");
        assertEq(gavelLot.ownerOf(tokenId), address(house.lotVault()), "before: vault holds NFT");

        house.settle(lotId);

        // After settle (same call): both changes took effect atomically.
        assertEq(house.claimable(seller), 1_000_000, "after: seller claimable");
        assertEq(gavelLot.ownerOf(tokenId), alice, "after: alice owns NFT");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 12 — Tiny lot end-to-end (0.10 USDC reserve, 0.05 increment)
    // ══════════════════════════════════════════════════════════════════════════
    function test_12_TinyLot_EndToEnd() public {
        uint256 lotId = _list(seller, 100_000, 50_000, 300);

        _bid(alice, lotId, 100_000);
        _bid(bob,   lotId, 150_000);
        _bid(carol, lotId, 200_000);

        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);

        assertEq(gavelLot.ownerOf(_lotTokenId(lotId)), carol,   "carol wins NFT");
        assertEq(house.claimable(seller),              200_000, "seller claimable");
        assertFalse(_lotBondReleased(lotId), "bond held");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 13 — Bond lifecycle
    // ══════════════════════════════════════════════════════════════════════════
    function test_13_BondLifecycle() public {
        // ── Part A: confirmDelivery releases bond ──────────────────────────────
        uint256 lotA = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, lotA, 1_000_000);
        vm.warp(_lotDeadline(lotA) + 1);
        house.settle(lotA);

        uint256 sellerAfterHammer = house.claimable(seller);
        assertEq(sellerAfterHammer, 1_000_000, "seller credited with bid after hammer");
        assertFalse(_lotBondReleased(lotA), "bond held after hammer");

        vm.prank(alice);
        house.confirmDelivery(lotA);

        assertTrue(_lotBondReleased(lotA), "bond released after confirmDelivery");
        // Seller claimable gains the bond (also 1_000_000).
        assertEq(house.claimable(seller), sellerAfterHammer + 1_000_000,
            "seller gains bond after confirmDelivery");

        // ── Part B: releaseBondAfterTimeout ────────────────────────────────────
        uint256 lotB = _list(seller, 1_000_000, 100_000, 300);
        _bid(bob, lotB, 1_000_000);
        vm.warp(_lotDeadline(lotB) + 1);
        house.settle(lotB);

        // Before 7 days: reverts.
        vm.expectRevert("AuctionHouse: bond timeout");
        house.releaseBondAfterTimeout(lotB);

        // After 7 days: succeeds.
        vm.warp(_lotSettledAt(lotB) + BOND_TIMEOUT);
        uint256 sellerBeforeTimeout = house.claimable(seller);
        house.releaseBondAfterTimeout(lotB);

        assertTrue(_lotBondReleased(lotB), "bond released after timeout");
        assertEq(house.claimable(seller), sellerBeforeTimeout + 1_000_000,
            "seller gains bond after timeout");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 14 — Dispute resolution
    // ══════════════════════════════════════════════════════════════════════════
    function test_14_DisputeResolution() public {
        // ── Lot A: sellerAtFault=true → bond to winner ────────────────────────
        uint256 lotA = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, lotA, 1_000_000);
        vm.warp(_lotDeadline(lotA) + 1);
        house.settle(lotA);

        vm.prank(alice);
        house.dispute(lotA);

        uint256 aliceBefore = house.claimable(alice);
        house.resolveDispute(lotA, true); // seller at fault → winner gets bond
        assertEq(house.claimable(alice), aliceBefore + 1_000_000,
            "alice gets bond (seller at fault)");
        assertTrue(_lotBondReleased(lotA), "bond released");

        // ── Lot B: sellerAtFault=false → bond to seller ───────────────────────
        uint256 lotB = _list(seller, 1_000_000, 100_000, 300);
        _bid(bob, lotB, 1_000_000);
        vm.warp(_lotDeadline(lotB) + 1);
        house.settle(lotB);

        vm.prank(bob);
        house.dispute(lotB);

        uint256 sellerBefore = house.claimable(seller);
        house.resolveDispute(lotB, false); // seller not at fault → seller keeps bond
        assertEq(house.claimable(seller), sellerBefore + 1_000_000,
            "seller gets bond (not at fault)");

        // ── Lot C: resolveDisputeTimeout ──────────────────────────────────────
        uint256 lotC = _list(seller, 1_000_000, 100_000, 300);
        _bid(carol, lotC, 1_000_000);
        vm.warp(_lotDeadline(lotC) + 1);
        house.settle(lotC);

        vm.prank(carol);
        house.dispute(lotC);

        // Before 14 days: reverts.
        vm.expectRevert("AuctionHouse: arbitration window open");
        house.resolveDisputeTimeout(lotC);

        // After 14 days: succeeds; bond goes to seller.
        vm.warp(_lotSettledAt(lotC) + DISPUTE_RESOLVE_TIMEOUT);
        uint256 sellerBefore2 = house.claimable(seller);
        house.resolveDisputeTimeout(lotC);
        assertEq(house.claimable(seller), sellerBefore2 + 1_000_000,
            "seller gets bond after dispute timeout");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 15 — 6-decimal accounting invariant
    // house balance == sumClaimable + active highest bids + active bonds
    // ══════════════════════════════════════════════════════════════════════════
    function test_15_AccountingInvariant() public {
        // Step 1: List lot (bond pulled in).
        uint256 lotId1 = _list(seller, 1_000_000, 100_000, 3600);
        _assertInvariant("after list");

        // Step 2: Alice bids.
        _bid(alice, lotId1, 1_000_000);
        _assertInvariant("after alice bid");

        // Step 3: Bob outbids alice (alice gets 1_000_000 in claimable).
        _bid(bob, lotId1, 1_100_000);
        _assertInvariant("after bob outbid alice");

        // Step 4: Settle (winner gets NFT, seller gets 1_100_000 claimable, bond held).
        vm.warp(_lotDeadline(lotId1) + 1);
        house.settle(lotId1);
        _assertInvariant("after settle lot1");

        // Step 5: confirmDelivery (bond credited to seller).
        vm.prank(bob);
        house.confirmDelivery(lotId1);
        _assertInvariant("after confirmDelivery lot1");

        // Step 6: Alice claims.
        vm.prank(alice);
        house.claim();
        _assertInvariant("after alice claim");

        // Step 7: seller claims.
        vm.prank(seller);
        house.claim();
        _assertInvariant("after seller claim");

        // Step 8: List another lot; cancel it (no bids).
        uint256 lotId2 = _list(seller, 500_000, 50_000, 300);
        _assertInvariant("after list lot2");

        vm.prank(seller);
        house.cancel(lotId2);
        _assertInvariant("after cancel lot2");

        // seller claims the bond back.
        vm.prank(seller);
        house.claim();
        _assertInvariant("after seller claims cancel bond");

        // Step 9: List lot3, let it expire unsold.
        uint256 lotId3 = _list(seller, 200_000, 20_000, 300);
        _assertInvariant("after list lot3");

        vm.warp(_lotDeadline(lotId3) + 1);
        house.settle(lotId3);
        _assertInvariant("after unsold settle lot3");
    }

    /// @dev Compute and assert the accounting invariant.
    ///      house_balance == sum(claimable) + sum(active bids) + sum(active bonds)
    ///
    ///  "active bond"  = lot bond that has NOT been released yet:
    ///    (a) open lots (not settled, not cancelled) — bond is held but not yet
    ///        counted elsewhere
    ///    (b) sold lots where bondReleased==false (hammer struck, delivery pending)
    ///
    ///  "active bid" = highestBid for an open (not settled, not cancelled) lot
    ///                that has at least one bid.
    ///
    ///  Note: for open lots (a), bond + highestBid are separate balances held by
    ///        the house.  For settled lots (b), only the unreleased bond remains
    ///        (the winning bid was already credited to seller's claimable).
    function _assertInvariant(string memory label) internal view {
        uint256 houseBalance = usdc.balanceOf(address(house));

        // Sum all claimable for known addresses.
        address[7] memory knownAddrs = [
            seller, alice, bob, carol, dave, address(this), address(house)
        ];
        uint256 sumClaimable;
        for (uint256 i = 0; i < knownAddrs.length; i++) {
            sumClaimable += house.claimable(knownAddrs[i]);
        }

        uint256 sumActiveBids;
        uint256 sumActiveBonds;
        uint256 total = house.nextLotId();

        for (uint256 id = 0; id < total; id++) {
            address lotSeller = _lotSeller(id);
            if (lotSeller == address(0)) continue;

            bool settled    = _lotSettled(id);
            bool cancelled  = _lotCancelled(id);
            bool bondReleased = _lotBondReleased(id);
            uint256 highestBid = _lotHighestBid(id);
            uint256 bond = _lotBond(id);

            bool isOpen = !settled && !cancelled;

            if (isOpen) {
                // Open lot: bond is held by the house.
                sumActiveBonds += bond;
                // Plus any current highest bid.
                sumActiveBids += highestBid;
            } else if (settled && !bondReleased) {
                // Sold lot with bond still held.
                sumActiveBonds += bond;
            }
            // cancelled lots: bond already credited to claimable; bondReleased=true.
            // unsold lots (settled, bondReleased=true): bond already in claimable.
        }

        uint256 expected = sumClaimable + sumActiveBids + sumActiveBonds;
        assertEq(houseBalance, expected, string.concat("invariant: ", label));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 16 — Reentrancy on claim is blocked
    // ══════════════════════════════════════════════════════════════════════════
    function test_16_ReentrancyOnClaim() public {
        // Deploy attacker.
        ReentrancyAttacker attacker = new ReentrancyAttacker(house);

        // Wire the reentrancy hook into MockUSDC.
        usdc.setTransferHook(address(attacker));

        // Give the attacker a claimable balance via the outbid mechanism.
        uint256 lotId = _list(seller, 1_000_000, 100_000, 300);

        usdc.mint(address(attacker), 1_000_000);
        vm.startPrank(address(attacker));
        usdc.approve(address(house), 1_000_000);
        house.bid(lotId, 1_000_000);
        vm.stopPrank();

        // Bob outbids attacker → attacker.claimable becomes 1_000_000.
        _bid(bob, lotId, 1_100_000);
        assertEq(house.claimable(address(attacker)), 1_000_000, "attacker has claimable");

        // Attacker calls claim():
        //   1. claimable set to 0 (effects first, CEI)
        //   2. usdc.transfer() fires → onTransfer hook → tries to reenter claim()
        //   3. reentry reverts because ReentrancyGuard status is ENTERED
        attacker.doClaim();

        assertTrue(attacker.reentered(),     "hook was called (reentrancy attempted)");
        assertTrue(attacker.reentryReverted(), "reentry was correctly blocked");

        // First claim paid out successfully.
        assertEq(usdc.balanceOf(address(attacker)), 1_000_000, "attacker received funds once");
        assertEq(house.claimable(address(attacker)), 0,        "attacker claimable fully drained");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 17 — Pause behaviour
    // ══════════════════════════════════════════════════════════════════════════
    function test_17_PauseBehaviour() public {
        // List a lot and place bids BEFORE pausing.
        uint256 lotId = _list(seller, 1_000_000, 100_000, 3600);
        _bid(alice, lotId, 1_000_000);
        _bid(bob,   lotId, 1_100_000); // alice outbid → alice.claimable = 1_000_000

        // Pause.
        house.pause();

        // list() reverts while paused.
        usdc.mint(seller, 1_000_000);
        vm.startPrank(seller);
        usdc.approve(address(house), 1_000_000);
        vm.expectRevert("AuctionHouse: paused");
        house.list("ipfs://paused", 1_000_000, 300, 100_000);
        vm.stopPrank();

        // bid() reverts while paused.
        usdc.mint(carol, 1_200_000);
        vm.startPrank(carol);
        usdc.approve(address(house), 1_200_000);
        vm.expectRevert("AuctionHouse: paused");
        house.bid(lotId, 1_200_000);
        vm.stopPrank();

        // settle() still works after auction ends (not gated by pause).
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId); // must NOT revert

        // claim() still works while paused.
        vm.prank(alice);
        house.claim();

        // confirmDelivery still works while paused.
        vm.prank(bob);
        house.confirmDelivery(lotId);

        // For dispute / resolveDispute: unpause briefly to list+sell a lot, then re-pause.
        house.unpause();
        uint256 lotId2 = _list(seller, 1_000_000, 100_000, 300);
        _bid(dave, lotId2, 1_000_000);
        vm.warp(_lotDeadline(lotId2) + 1);
        house.settle(lotId2);
        house.pause(); // re-pause

        vm.prank(dave);
        house.dispute(lotId2); // still works while paused

        house.resolveDispute(lotId2, false); // onlyOwner, still works while paused

        // releaseBondAfterTimeout: unpause, create a lot, re-pause after settle.
        house.unpause();
        uint256 lotId3 = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, lotId3, 1_000_000);
        vm.warp(_lotDeadline(lotId3) + 1);
        house.settle(lotId3);
        house.pause(); // re-pause

        vm.warp(_lotSettledAt(lotId3) + BOND_TIMEOUT);
        house.releaseBondAfterTimeout(lotId3); // still works while paused
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 18 — Cancel
    // ══════════════════════════════════════════════════════════════════════════
    function test_18_Cancel() public {
        // ── Part A: cancel with no bids succeeds ──────────────────────────────
        uint256 lotA = _list(seller, 1_000_000, 100_000, 3600);
        uint256 tokenIdA = _lotTokenId(lotA);

        // Before cancel: vault holds NFT.
        assertEq(gavelLot.ownerOf(tokenIdA), address(house.lotVault()),
            "vault holds NFT before cancel");

        vm.prank(seller);
        house.cancel(lotA);

        assertTrue(_lotCancelled(lotA), "lot cancelled");

        // Bond returned to seller's claimable.
        assertEq(house.claimable(seller), 1_000_000, "seller bond returned via claimable");

        // NFT returned to seller.
        assertEq(gavelLot.ownerOf(tokenIdA), seller, "seller gets NFT after cancel");

        // ── Part B: cancel with bids reverts ──────────────────────────────────
        uint256 lotB = _list(seller, 1_000_000, 100_000, 3600);
        _bid(alice, lotB, 1_000_000);

        vm.prank(seller);
        vm.expectRevert("AuctionHouse: already has bids");
        house.cancel(lotB);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Helpers for bidWithAuthorization tests (test_19–test_25)
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Compute the EIP-3009 nonce exactly as the contract does:
    ///      keccak256(abi.encode(address(house), block.chainid, lotId, amount, salt))
    function _computeNonce(
        uint256 lotId,
        uint256 amount,
        bytes32 salt
    ) internal view returns (bytes32) {
        return keccak256(abi.encode(address(house), block.chainid, lotId, amount, salt));
    }

    /// @dev Build the EIP-712 domain separator for MockUSDC (matches what MockUSDC
    ///      computes internally in receiveWithAuthorization when v != 0).
    function _usdcDomainSep() internal view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("Mock USDC")),
            keccak256(bytes("2")),
            block.chainid,
            USDC_ADDR
        ));
    }

    /// @dev Sign an EIP-3009 ReceiveWithAuthorization for MockUSDC.
    ///      Returns (v, r, s) suitable for passing directly to bidWithAuthorization.
    function _signReceiveAuth(
        uint256 privKey,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(abi.encode(
            keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"),
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _usdcDomainSep(), structHash));
        (v, r, s) = vm.sign(privKey, digest);
    }

    /// @dev Sign a real EIP-3009 ReceiveWithAuthorization with a known private key,
    ///      mint `amount` USDC to `from`, and call bidWithAuthorization as `relayer`.
    ///      MockUSDC now always verifies the signature — no bypass.
    function _relayedBidSigned(
        address relayer,
        uint256 bidderPrivKey,
        uint256 lotId,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 salt
    ) internal {
        address from = vm.addr(bidderPrivKey);
        bytes32 nonce = _computeNonce(lotId, amount, salt);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(
            bidderPrivKey, from, address(house),
            amount, validAfter, validBefore, nonce
        );
        usdc.mint(from, amount);
        vm.prank(relayer);
        house.bidWithAuthorization(lotId, amount, from, validAfter, validBefore, salt, v, r, s);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 19 — Happy path: relayer calls bidWithAuthorization with a REAL sig.
    //           Checks: highestBidder == bidder, highestBid == amount,
    //           RelayedBid event emitted with correct args.
    // ══════════════════════════════════════════════════════════════════════════
    function test_19_RelayedBid_HappyPath() public {
        uint256 bidderPrivKey = 0xB1DD3;
        address bidder  = vm.addr(bidderPrivKey);
        address relayer = makeAddr("relayer19");

        uint256 lotId      = _list(seller, 1_000_000, 100_000, 3600);
        uint256 bidAmount  = 1_000_000;
        bytes32 salt       = keccak256("salt-19");
        uint256 validAfter  = 0;
        uint256 validBefore = block.timestamp + 3600;

        bytes32 nonce = _computeNonce(lotId, bidAmount, salt);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(
            bidderPrivKey, bidder, address(house),
            bidAmount, validAfter, validBefore, nonce
        );

        uint256 relayerBalBefore = usdc.balanceOf(relayer);
        usdc.mint(bidder, bidAmount);

        // Expect RelayedBid(lotId, bidder, relayer, amount) — all topics + data.
        vm.expectEmit(true, true, true, true, address(house));
        emit AuctionHouse.RelayedBid(lotId, bidder, relayer, bidAmount);

        vm.prank(relayer);
        house.bidWithAuthorization(lotId, bidAmount, bidder, validAfter, validBefore, salt, v, r, s);

        // bidder is the highestBidder, NOT the relayer.
        assertEq(_lotHighestBidder(lotId), bidder,    "bidder should be highestBidder");
        assertEq(_lotHighestBid(lotId),    bidAmount, "highestBid should match amount");

        // Relayer's USDC balance is completely unchanged.
        assertEq(usdc.balanceOf(relayer), relayerBalBefore, "relayer balance unchanged");

        // Bidder's USDC balance was consumed (transferred into house).
        assertEq(usdc.balanceOf(bidder), 0, "bidder USDC consumed");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 20 — Wrong lotId: relayer submits with lotId=1 but sig covers lotId=0
    //           The nonce in the USDC call uses lotId=1 → sig verification fails.
    // ══════════════════════════════════════════════════════════════════════════
    function test_20_RelayedBid_WrongLotId_Reverts() public {
        uint256 bidderPrivKey = 0xB1DD4;
        address bidder        = vm.addr(bidderPrivKey);
        address relayer       = makeAddr("relayer");

        // List two lots so lotId=1 exists.
        uint256 lotId0 = _list(seller, 1_000_000, 100_000, 3600);
        uint256 lotId1 = _list(seller, 1_000_000, 100_000, 3600);
        assertEq(lotId0, 0, "lotId0 should be 0");
        assertEq(lotId1, 1, "lotId1 should be 1");

        uint256 bidAmount   = 1_000_000;
        uint256 validAfter  = 0;
        uint256 validBefore = block.timestamp + 3600;
        bytes32 salt        = keccak256("salt-20");

        // Bidder signs the EIP-3009 auth covering lotId=0 (the correct lot).
        // The nonce embedded is keccak256(abi.encode(house, chainid, 0, bidAmount, salt)).
        bytes32 nonceForLot0 = _computeNonce(lotId0, bidAmount, salt);
        usdc.mint(bidder, bidAmount);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(
            bidderPrivKey, bidder, address(house),
            bidAmount, validAfter, validBefore, nonceForLot0
        );

        // Relayer submits with lotId=1 instead. The contract recomputes:
        //   nonce = keccak256(abi.encode(house, chainid, 1, bidAmount, salt))
        // which differs from nonceForLot0. MockUSDC verifies sig over the new nonce
        // and ecrecover gives a different address → "MockUSDC: invalid signature".
        vm.prank(relayer);
        vm.expectRevert("MockUSDC: invalid signature");
        house.bidWithAuthorization(
            lotId1,      // wrong lot
            bidAmount,
            bidder,
            validAfter,
            validBefore,
            salt,
            v, r, s      // sig was over nonceForLot0, not nonceForLot1
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 21 — Wrong amount: relayer submits amount+1 but sig covers amount.
    //           Contract computes nonce with amount+1 → sig mismatch → revert.
    // ══════════════════════════════════════════════════════════════════════════
    function test_21_RelayedBid_WrongAmount_Reverts() public {
        uint256 bidderPrivKey = 0xB1DD5;
        address bidder        = vm.addr(bidderPrivKey);
        address relayer       = makeAddr("relayer");

        uint256 lotId       = _list(seller, 1_000_000, 100_000, 3600);
        uint256 signedAmount = 1_000_000;
        uint256 tamperedAmount = signedAmount + 1;
        uint256 validAfter  = 0;
        uint256 validBefore = block.timestamp + 3600;
        bytes32 salt        = keccak256("salt-21");

        // Bidder signs over signedAmount; nonce binds signedAmount.
        bytes32 nonceForCorrectAmount = _computeNonce(lotId, signedAmount, salt);
        usdc.mint(bidder, tamperedAmount);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(
            bidderPrivKey, bidder, address(house),
            signedAmount, validAfter, validBefore, nonceForCorrectAmount
        );

        // Relayer submits tamperedAmount. Contract computes nonce from tamperedAmount
        // → different nonce → sig won't verify → "MockUSDC: invalid signature".
        vm.prank(relayer);
        vm.expectRevert("MockUSDC: invalid signature");
        house.bidWithAuthorization(
            lotId,
            tamperedAmount,   // different from what was signed
            bidder,
            validAfter,
            validBefore,
            salt,
            v, r, s
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 22 — Replay: after a successful bidWithAuthorization, MockUSDC marks
    //           the nonce as used. A second receiveWithAuthorization with the same
    //           nonce (same lotId, amount, salt) reverts "MockUSDC: nonce used".
    //
    //           Because _bidCore runs before the USDC call (CEI), re-submitting
    //           the same bid via bidWithAuthorization would be rejected by _bidCore
    //           first ("increment too low") once the lot has progressed. We therefore
    //           verify nonce replay protection at the USDC level directly: after the
    //           first successful relayed bid, the nonce is consumed, and a direct
    //           USDC call with that nonce reverts — proving the nonce cannot be
    //           recycled by a second AuctionHouse call on any lot.
    // ══════════════════════════════════════════════════════════════════════════
    function test_22_RelayedBid_Replay_Reverts() public {
        uint256 bidderPrivKey = 0xB1DD7;
        address bidder  = vm.addr(bidderPrivKey);
        address relayer = makeAddr("relayer22");

        uint256 lotId     = _list(seller, 1_000_000, 100_000, 3600);
        uint256 bidAmount = 1_000_000;
        bytes32 salt      = keccak256("salt-22");
        uint256 vb        = block.timestamp + 3600;

        // First call succeeds with a real signature; MockUSDC marks the nonce as used.
        _relayedBidSigned(relayer, bidderPrivKey, lotId, bidAmount, 0, vb, salt);

        // Confirm the nonce is now consumed in MockUSDC's state.
        bytes32 usedNonce = _computeNonce(lotId, bidAmount, salt);
        assertTrue(usdc.authorizationState(bidder, usedNonce), "nonce must be marked used");

        // A second call to USDC's receiveWithAuthorization with the same nonce
        // must revert with "MockUSDC: nonce used" — regardless of the signature.
        // Sign again with the same parameters to produce a valid sig; it should still
        // fail on the nonce check before sig verification.
        bytes32 nonce = _computeNonce(lotId, bidAmount, salt); // same nonce
        (uint8 v2, bytes32 r2, bytes32 s2) = _signReceiveAuth(
            bidderPrivKey, bidder, address(house), bidAmount, 0, vb, nonce
        );
        usdc.mint(bidder, bidAmount); // re-fund to isolate the nonce check from balance
        vm.prank(address(house));
        vm.expectRevert("MockUSDC: nonce used");
        usdc.receiveWithAuthorization(bidder, address(house), bidAmount, 0, vb, usedNonce, v2, r2, s2);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 23 — Wrong contract: sig intended for a different AuctionHouse address.
    //           Nonce embedded a different address(this) → recomputed nonce differs
    //           → MockUSDC sig verification fails.
    // ══════════════════════════════════════════════════════════════════════════
    function test_23_RelayedBid_WrongContract_Reverts() public {
        uint256 bidderPrivKey = 0xB1DD6;
        address bidder        = vm.addr(bidderPrivKey);
        address relayer       = makeAddr("relayer");

        uint256 lotId       = _list(seller, 1_000_000, 100_000, 3600);
        uint256 bidAmount   = 1_000_000;
        uint256 validAfter  = 0;
        uint256 validBefore = block.timestamp + 3600;
        bytes32 salt        = keccak256("salt-23");

        // Bidder signs with a DIFFERENT (fake) AuctionHouse address baked into the nonce.
        address fakeHouse = makeAddr("fakeHouse");
        bytes32 nonceForFakeHouse = keccak256(abi.encode(fakeHouse, block.chainid, lotId, bidAmount, salt));

        usdc.mint(bidder, bidAmount);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(
            bidderPrivKey, bidder, address(house),
            bidAmount, validAfter, validBefore, nonceForFakeHouse
        );

        // Contract recomputes nonce with address(house) (the real one) → different nonce
        // → signature won't verify → "MockUSDC: invalid signature".
        vm.prank(relayer);
        vm.expectRevert("MockUSDC: invalid signature");
        house.bidWithAuthorization(
            lotId,
            bidAmount,
            bidder,
            validAfter,
            validBefore,
            salt,
            v, r, s
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 24 — Expired validBefore: call reverts "MockUSDC: expired"
    // ══════════════════════════════════════════════════════════════════════════
    function test_24_RelayedBid_ExpiredValidBefore_Reverts() public {
        uint256 bidderPrivKey = 0xB1DD8;
        address bidder  = vm.addr(bidderPrivKey);
        address relayer = makeAddr("relayer24");

        uint256 lotId      = _list(seller, 1_000_000, 100_000, 3600);
        uint256 bidAmount  = 1_000_000;
        bytes32 salt       = keccak256("salt-24");

        // validBefore is already in the past.
        uint256 expiredBefore = block.timestamp - 1;

        bytes32 nonce = _computeNonce(lotId, bidAmount, salt);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(
            bidderPrivKey, bidder, address(house),
            bidAmount, 0, expiredBefore, nonce
        );

        usdc.mint(bidder, bidAmount);

        vm.prank(relayer);
        vm.expectRevert("MockUSDC: expired");
        house.bidWithAuthorization(lotId, bidAmount, bidder, 0, expiredBefore, salt, v, r, s);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 25 — Soft-close via relayed bid + outbid refund
    //           List with 15-second duration, warp to 8 s before deadline,
    //           relay bidder1's bid → Extended event. Then relay bidder2 with
    //           higher amount → bidder1's claimable == firstBid.
    // ══════════════════════════════════════════════════════════════════════════
    function test_25_RelayedBid_SoftClose_AndRefund() public {
        uint256 bidder1PrivKey = 0xB1DD9;
        uint256 bidder2PrivKey = 0xB1DDA;
        address bidder1  = vm.addr(bidder1PrivKey);
        address bidder2  = vm.addr(bidder2PrivKey);
        address relayer  = makeAddr("relayer25");

        // List with 15-second duration.
        uint256 lotId = _list(seller, 1_000_000, 100_000, 15);

        uint256 firstBid  = 1_000_000;
        uint256 secondBid = 1_100_000;  // firstBid + minIncrement (100_000)
        bytes32 salt1     = keccak256("salt-25-bid1");
        bytes32 salt2     = keccak256("salt-25-bid2");

        // Warp to 8 seconds before deadline (within SOFT_CLOSE_WINDOW = 10).
        vm.warp(_lotDeadline(lotId) - 8);

        uint256 vb = block.timestamp + 3600;

        // Relay bidder1's real-signed bid.
        _relayedBidSigned(relayer, bidder1PrivKey, lotId, firstBid, 0, vb, salt1);

        // Deadline extended by soft close.
        assertEq(_lotExtensions(lotId), 1, "extensions == 1 after first relayed bid");
        assertGt(_lotDeadline(lotId), block.timestamp, "deadline is in the future");
        assertEq(_lotHighestBidder(lotId), bidder1, "bidder1 is highestBidder");

        // Relay bidder2's real-signed higher bid with a fresh salt.
        _relayedBidSigned(relayer, bidder2PrivKey, lotId, secondBid, 0, vb, salt2);

        // bidder1 should now have firstBid in claimable (outbid refund).
        assertEq(house.claimable(bidder1), firstBid, "bidder1 claimable == firstBid after outbid");

        // bidder2 is new highest bidder.
        assertEq(_lotHighestBidder(lotId), bidder2,  "bidder2 is highestBidder");
        assertEq(_lotHighestBid(lotId),    secondBid, "highestBid == secondBid");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Helpers shared by ReputationWriter tests (test_26–test_33)
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Deploy a fresh ReputationWriter wired to mock registries and
    ///      hook it into `house`.  Returns the three deployed contracts.
    function _deployRW() internal returns (
        ReputationWriter rw,
        MockIdentityRegistry mockIdentity,
        MockReputationRegistry mockReputation
    ) {
        mockIdentity    = new MockIdentityRegistry();
        mockReputation  = new MockReputationRegistry();
        rw = new ReputationWriter(
            address(this),          // owner (test contract is owner of house)
            address(house),
            address(mockIdentity),
            address(mockReputation)
        );
        house.setReputationWriter(address(rw));
    }

    /// @dev List + bid (by `buyer`) + settle + confirmDelivery for one lot.
    ///      Returns the lotId.  Requires rw is already wired into house.
    function _listBidSettleConfirm(
        address _seller,
        address buyer,
        uint256 reserve
    ) internal returns (uint256 lotId) {
        lotId = house.nextLotId();

        // Mint bond for seller.  Bond may be discounted if seller has >= 3 clean
        // sales, so we mint the full reserve and cap the approval likewise.
        usdc.mint(_seller, reserve);
        vm.startPrank(_seller);
        usdc.approve(address(house), reserve);
        house.list("ipfs://rw-test", reserve, 3600, 1);
        vm.stopPrank();

        // Mint bid for buyer and bid.
        _bid(buyer, lotId, reserve);

        // Warp past deadline and settle.
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);

        // Buyer confirms delivery.
        vm.prank(buyer);
        house.confirmDelivery(lotId);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 26 — recordSale only after confirmed delivery
    // ══════════════════════════════════════════════════════════════════════════
    function test_26_RecordSale_OnlyAfterBondReleased() public {
        (ReputationWriter rw,,) = _deployRW();

        uint256 lotId = house.nextLotId();
        usdc.mint(seller, 1_000_000);
        vm.startPrank(seller);
        usdc.approve(address(house), 1_000_000);
        house.list("ipfs://t26", 1_000_000, 3600, 1);
        vm.stopPrank();

        _bid(alice, lotId, 1_000_000);

        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);

        // Bond NOT released yet → recordSale must revert.
        vm.expectRevert("ReputationWriter: bond not released");
        rw.recordSale(lotId);

        // Confirm delivery → bond released.
        vm.prank(alice);
        house.confirmDelivery(lotId);

        // Now recordSale must succeed.
        rw.recordSale(lotId);

        // clean sale incremented.
        assertEq(rw.cleanSales(seller), 1, "cleanSales should be 1 after positive sale");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 27 — once per lot: second recordSale reverts "already recorded"
    // ══════════════════════════════════════════════════════════════════════════
    function test_27_RecordSale_AlreadyRecorded_Reverts() public {
        (ReputationWriter rw,,) = _deployRW();

        uint256 lotId = _listBidSettleConfirm(seller, alice, 1_000_000);

        rw.recordSale(lotId);   // first call succeeds

        vm.expectRevert("ReputationWriter: already recorded");
        rw.recordSale(lotId);   // second call must revert
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 28 — negative feedback on disputed sale (seller at fault)
    // ══════════════════════════════════════════════════════════════════════════
    function test_28_RecordSale_Negative_OnDispute() public {
        (ReputationWriter rw, MockIdentityRegistry mockIdentity, MockReputationRegistry mockReputation) = _deployRW();

        // List, bid, settle.
        uint256 lotId = house.nextLotId();
        usdc.mint(seller, 1_000_000);
        vm.startPrank(seller);
        usdc.approve(address(house), 1_000_000);
        house.list("ipfs://t28", 1_000_000, 3600, 1);
        vm.stopPrank();

        _bid(alice, lotId, 1_000_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);

        // Alice raises dispute.
        vm.prank(alice);
        house.dispute(lotId);

        // Owner resolves: seller at fault → bond goes to winner (alice).
        house.resolveDispute(lotId, true);

        // Register seller as an agent so the feedback path is exercised.
        vm.prank(seller);
        uint256 agentId = mockIdentity.register();   // agentId == 0
        vm.prank(seller);
        rw.linkSeller(agentId);

        // recordSale → disputed==true → positive=false.
        rw.recordSale(lotId);

        // cleanSales must NOT be incremented for a negative sale.
        assertEq(rw.cleanSales(seller), 0, "disputed sale: cleanSales stays 0");

        // MockReputationRegistry should have received a -1 score.
        assertEq(mockReputation.callCount(), 1,  "giveFeedback called once");
        assertEq(mockReputation.lastValue(),  -1, "feedback value is -1");

        // lotRecorded must be true.
        assertTrue(rw.lotRecorded(lotId), "lot marked recorded");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 29 — self-sale does not increment cleanSales
    // ══════════════════════════════════════════════════════════════════════════
    function test_29_SellerCannotBidOwnLot() public {
        uint256 lotId = _list(seller, 1_000_000, 1, 3600);
        usdc.mint(seller, 1_000_000);
        vm.startPrank(seller);
        usdc.approve(address(house), 1_000_000);
        vm.expectRevert("AuctionHouse: seller cannot bid");
        house.bid(lotId, 1_000_000);
        vm.stopPrank();
        assertEq(_lotHighestBidder(lotId), address(0), "no bid recorded");
    }

    function test_34_SellerCannotBidOwnLot_Relayed() public {
        uint256 pk = 0x5E11E4;
        address s2 = vm.addr(pk);
        uint256 lotId = _list(s2, 1_000_000, 1, 3600);
        bytes32 salt = keccak256("salt-34");
        uint256 vb = block.timestamp + 3600;
        bytes32 nonce = _computeNonce(lotId, 1_000_000, salt);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(pk, s2, address(house), 1_000_000, 0, vb, nonce);
        usdc.mint(s2, 1_000_000);
        vm.prank(makeAddr("relayer34"));
        vm.expectRevert("AuctionHouse: seller cannot bid");
        house.bidWithAuthorization(lotId, 1_000_000, s2, 0, vb, salt, v, r, s);
    }

    function test_35_ZeroBidReverts() public {
        uint256 lotId = _list(seller, 0, 1, 3600);
        vm.prank(alice);
        vm.expectRevert("AuctionHouse: zero bid");
        house.bid(lotId, 0);
    }

    function test_36_NFTRejectingWinnerCannotBlockSettle() public {
        NFTRejecter rej = new NFTRejecter();
        uint256 lotId = _list(seller, 1_000_000, 1, 3600);
        _bid(address(rej), lotId, 1_000_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        assertEq(gavelLot.ownerOf(_lotTokenId(lotId)), address(rej), "winner holds NFT");
        assertEq(house.claimable(seller), 1_000_000, "seller credited");
    }

    function test_37_FundsConservation_FullLifecycle() public {
        uint256 lotId = _list(seller, 700_000, 280_000, 3600);
        _bid(alice, lotId, 700_000);
        _bid(bob,   lotId, 980_000);
        _bid(alice, lotId, 1_260_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        vm.prank(alice); house.confirmDelivery(lotId);
        vm.prank(alice); house.claim();
        vm.prank(bob);   house.claim();
        vm.prank(seller); house.claim();
        assertEq(usdc.balanceOf(alice), 700_000, "alice: first bid back");
        assertEq(usdc.balanceOf(bob), 980_000, "bob: full refund");
        assertEq(usdc.balanceOf(seller), 1_960_000, "seller: 1.26 + 0.70 bond");
        assertEq(usdc.balanceOf(address(house)), 0, "house holds nothing");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 30 — bond drops to 50% after 3 clean sales
    // ══════════════════════════════════════════════════════════════════════════
    function test_30_BondDiscount_After3CleanSales() public {
        (ReputationWriter rw,,) = _deployRW();

        uint256 reserve = 200_000; // 0.20 USDC

        // Accumulate 3 clean sales for `seller` using `alice` as buyer.
        for (uint256 i = 0; i < 3; i++) {
            uint256 lotId = _listBidSettleConfirm(seller, alice, reserve);
            rw.recordSale(lotId);
        }

        assertEq(rw.cleanSales(seller), 3, "should have 3 clean sales");

        // Now list a new lot.  Bond should be 50% of reserve = 100_000.
        uint256 newLotId = house.nextLotId();

        // Mint the full reserve just in case, but the bond pulled should be 50%.
        usdc.mint(seller, reserve);
        vm.startPrank(seller);
        usdc.approve(address(house), reserve);
        house.list("ipfs://t30-discounted", reserve, 3600, 1);
        vm.stopPrank();

        uint256 bondStored = _lotBond(newLotId);
        assertEq(bondStored, reserve / 2, "bond should be 50% after 3 clean sales");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 31 — reputationWriter cleanSalesView revert does not block list()
    // ══════════════════════════════════════════════════════════════════════════
    function test_31_CleanSalesViewRevert_DoesNotBlockList() public {
        // Deploy a MockReputationWriter that will revert on cleanSalesView.
        MockReputationWriter mockRW = new MockReputationWriter();
        mockRW.setRevertOnCleanSales(true);

        // Wire the mock into the house.
        house.setReputationWriter(address(mockRW));

        uint256 reserve = 1_000_000;

        // list() should still succeed; bond falls back to 100% of reserve.
        uint256 lotId = house.nextLotId();
        usdc.mint(seller, reserve);
        vm.startPrank(seller);
        usdc.approve(address(house), reserve);
        house.list("ipfs://t31", reserve, 3600, 1); // must NOT revert
        vm.stopPrank();

        // Bond stored should be the full reserve (fallback to 100%).
        assertEq(_lotBond(lotId), reserve, "bond should be full reserve when cleanSalesView reverts");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 32 — linkSeller reverts if caller is not the agentId owner
    // ══════════════════════════════════════════════════════════════════════════
    function test_32_LinkSeller_WrongOwner_Reverts() public {
        (ReputationWriter rw, MockIdentityRegistry mockIdentity,) = _deployRW();

        // Register agentId under `seller`.
        vm.prank(seller);
        uint256 agentId = mockIdentity.register(); // seller owns agentId 0

        // Alice tries to link herself to seller's agentId → must revert.
        vm.prank(alice);
        vm.expectRevert("ReputationWriter: not agentId owner");
        rw.linkSeller(agentId);

        // Seller can link successfully.
        vm.prank(seller);
        rw.linkSeller(agentId);
        assertTrue(rw.sellerRegistered(seller), "seller should be registered");
        assertEq(rw.sellerAgentId(seller), agentId, "agentId stored correctly");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 33 — ReputationWriterUpdated event emitted on setReputationWriter
    // ══════════════════════════════════════════════════════════════════════════
    function test_33_ReputationWriterUpdated_EventEmitted() public {
        address oldWriter = address(0);   // house starts with no writer
        address newWriter = makeAddr("rw-addr");

        vm.expectEmit(true, true, false, false, address(house));
        emit AuctionHouse.ReputationWriterUpdated(oldWriter, newWriter);

        house.setReputationWriter(newWriter);
        assertEq(house.reputationWriter(), newWriter, "reputationWriter updated");

        // Update again: old is now newWriter, new is address(0).
        address newerWriter = makeAddr("rw-addr-2");

        vm.expectEmit(true, true, false, false, address(house));
        emit AuctionHouse.ReputationWriterUpdated(newWriter, newerWriter);

        house.setReputationWriter(newerWriter);
        assertEq(house.reputationWriter(), newerWriter, "reputationWriter updated again");
    }
}
