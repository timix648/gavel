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
import {MockERC721}              from "../test-helpers/MockERC721.sol";
import {MockERC1155}             from "../test-helpers/MockERC1155.sol";
import {MockERC20}               from "../test-helpers/MockERC20.sol";
import {FeeOnTransferMock}       from "../test-helpers/FeeOnTransferMock.sol";
import {BlocklistERC20Mock}      from "../test-helpers/BlocklistERC20Mock.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Reentrancy attacker (Test 16)
// ─────────────────────────────────────────────────────────────────────────────
contract ReentrancyAttacker is ITransferHook {
    AuctionHouse public house;
    bool public reentered;
    bool public reentryReverted;

    constructor(AuctionHouse _house) { house = _house; }

    function onTransfer(address, uint256) external override {
        reentered = true;
        try house.claim() {
            reentryReverted = false;
        } catch {
            reentryReverted = true;
        }
    }

    function doClaim() external { house.claim(); }
}

contract NFTRejecter {
    // No onERC721Received: a safeTransferFrom to this contract would revert.
}

// ─────────────────────────────────────────────────────────────────────────────
// Main test contract
// ─────────────────────────────────────────────────────────────────────────────
contract AuctionHouseTest is Test {
    address internal constant USDC_ADDR = 0x3600000000000000000000000000000000000000;

    AuctionHouse internal house;
    MockUSDC     internal usdc;
    GavelLot     internal gavelLot;

    address internal seller  = makeAddr("seller");
    address internal alice   = makeAddr("alice");
    address internal bob     = makeAddr("bob");
    address internal carol   = makeAddr("carol");
    address internal dave    = makeAddr("dave");

    uint256 internal constant SOFT_CLOSE_WINDOW       = 10;
    uint256 internal constant MAX_EXTENSIONS          = 500;
    uint256 internal constant BOND_TIMEOUT            = 7 days;
    uint256 internal constant DISPUTE_RESOLVE_TIMEOUT = 14 days;
    uint256 internal constant DELIVERY_WINDOW         = 7 days;

    function setUp() public {
        MockUSDC mock = new MockUSDC();
        vm.etch(USDC_ADDR, address(mock).code);
        usdc = MockUSDC(USDC_ADDR);
        house    = new AuctionHouse(address(this));
        gavelLot = house.gavelLot();
    }

    // ── Lot struct field getters ───────────────────────────────────────────────
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

    /// @dev List an OFFCHAIN lot.
    function _list(address _seller, uint256 reserve, uint256 minIncrement, uint256 duration)
        internal returns (uint256 lotId)
    {
        lotId = house.nextLotId();
        usdc.mint(_seller, reserve);
        vm.startPrank(_seller);
        usdc.approve(address(house), reserve);
        house.list(AuctionHouse.Kind.OFFCHAIN, address(0), 0, 0, "ipfs://test", reserve, duration, minIncrement);
        vm.stopPrank();
    }

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
        _bid(alice, lotId, 2_000_000);
        _bid(bob,   lotId, 2_500_000);
        _bid(carol, lotId, 3_000_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        // For OFFCHAIN: winner gets the GavelLot NFT, payment goes to escrow.
        assertEq(gavelLot.ownerOf(_lotTokenId(lotId)), carol, "carol should own NFT");
        // Seller NOT credited yet (payment in escrow).
        assertEq(house.claimable(seller), 0, "seller not credited until escrow released");
        assertFalse(_lotBondReleased(lotId), "bond held");
        // EscrowState == HELD
        assertEq(uint8(house.escrowState(lotId)), uint8(AuctionHouse.EscrowState.HELD), "escrow HELD");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 2 — Soft close
    // ══════════════════════════════════════════════════════════════════════════
    function test_02_SoftClose_ExtendDeadline() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 300);
        uint256 deadlineBefore = _lotDeadline(lotId);
        vm.warp(deadlineBefore - 3);
        _bid(alice, lotId, 1_000_000);
        uint256 deadlineAfter = _lotDeadline(lotId);
        assertEq(deadlineAfter, block.timestamp + SOFT_CLOSE_WINDOW, "deadline after soft close");
        assertEq(_lotExtensions(lotId), 1, "extensions == 1");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 3 — MAX_EXTENSIONS cap: 501st bid does not extend (cap is 500)
    // ══════════════════════════════════════════════════════════════════════════
    function test_03_MaxExtensions_Cap() public {
        uint256 lotId = _list(seller, 1_000_000, 10_000, 300);
        uint256 bidAmount = 1_000_000;
        for (uint256 i = 0; i < MAX_EXTENSIONS; i++) {
            vm.warp(_lotDeadline(lotId) - 3);
            bidAmount += 10_000;
            address bidder = address(uint160(0xBEEF0000 + i));
            _bid(bidder, lotId, bidAmount);
        }
        assertEq(_lotExtensions(lotId), MAX_EXTENSIONS, "should have 500 extensions");
        uint256 dlAt500 = _lotDeadline(lotId);
        vm.warp(dlAt500 - 3);
        bidAmount += 10_000;
        address lastBidder = address(uint160(0xBEEF0000 + MAX_EXTENSIONS));
        _bid(lastBidder, lotId, bidAmount);
        assertEq(_lotExtensions(lotId), MAX_EXTENSIONS, "extensions stay at 500");
        assertEq(_lotDeadline(lotId), dlAt500, "deadline must NOT extend");
        vm.warp(dlAt500 + 1);
        house.settle(lotId);
        assertEq(gavelLot.ownerOf(_lotTokenId(lotId)), lastBidder, "last bidder wins NFT");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 4 — 20 late bids extend correctly, settle cleanly
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
        // OFFCHAIN: payment in escrow, not credited to seller yet.
        assertEq(house.claimable(seller), 0, "seller not credited before escrow release");
        assertEq(gavelLot.ownerOf(_lotTokenId(lotId)), lastBidder, "last bidder wins NFT");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 5 — Revert: below reserve, below increment
    // ══════════════════════════════════════════════════════════════════════════
    function test_05_RevertBelowReserveAndIncrement() public {
        uint256 lotId = _list(seller, 1_000_000, 500_000, 3600);
        usdc.mint(alice, 500_000);
        vm.startPrank(alice);
        usdc.approve(address(house), 500_000);
        vm.expectRevert("AuctionHouse: below reserve");
        house.bid(lotId, 500_000);
        vm.stopPrank();
        _bid(alice, lotId, 1_000_000);
        usdc.mint(bob, 1_000_000);
        vm.startPrank(bob);
        usdc.approve(address(house), 1_000_000);
        vm.expectRevert("AuctionHouse: increment too low");
        house.bid(lotId, 1_000_000);
        vm.stopPrank();
    }

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

    function test_07_OutbidCreditsClaimableAtomically() public {
        uint256 lotId = _list(seller, 1_000_000, 500_000, 3600);
        _bid(alice, lotId, 1_000_000);
        assertEq(house.claimable(alice), 0, "before outbid: alice 0");
        _bid(bob, lotId, 1_500_000);
        assertEq(house.claimable(alice), 1_000_000, "alice claimable after outbid");
    }

    function test_08_BlocklistedAddressCannotBlockOthers() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 3600);
        _bid(alice, lotId, 1_000_000);
        usdc.blocklist(alice);
        _bid(bob, lotId, 1_100_000);
        assertEq(house.claimable(alice), 1_000_000, "alice claimable after outbid");
        _bid(carol, lotId, 1_200_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        // OFFCHAIN: bob was outbid; his claimable is 1_100_000. carol is winner.
        uint256 bobClaimable = house.claimable(bob);
        assertGt(bobClaimable, 0, "bob has claimable");
        vm.prank(bob);
        house.claim();
        assertEq(house.claimable(bob), 0, "bob claimed");
        assertEq(house.claimable(alice), 1_000_000, "alice still has claimable");
        vm.prank(alice);
        vm.expectRevert("AuctionHouse: claim transfer failed");
        house.claim();
        assertEq(house.claimable(bob), 0, "bob unaffected");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 9 — Settle with no bids: NFT and bond returned to seller
    // ══════════════════════════════════════════════════════════════════════════
    function test_09_SettleNoBids_ReturnsBondAndNFT() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 300);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        assertTrue(_lotBondReleased(lotId), "bond released after unsold");
        assertEq(house.claimable(seller), 1_000_000, "seller claimable == bond");
        // In v7 the GavelLot NFT stays in the vault after unsold settle.
        // Seller calls claimLotAsset() to retrieve it.
        uint256 tokenId = _lotTokenId(lotId);
        assertEq(gavelLot.ownerOf(tokenId), address(house.lotVault()), "vault holds NFT after unsold settle");
        vm.prank(seller);
        house.claimLotAsset(lotId, seller);
        assertEq(gavelLot.ownerOf(tokenId), seller, "seller owns NFT after claimLotAsset");
    }

    function test_10_DoubleSettleReverts() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, lotId, 1_000_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        vm.expectRevert("AuctionHouse: inactive lot");
        house.settle(lotId);
    }

    function test_11_SettleAtomicity_NFTAndCreditSameTx() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, lotId, 1_000_000);
        vm.warp(_lotDeadline(lotId) + 1);
        uint256 tokenId = _lotTokenId(lotId);
        assertEq(house.claimable(seller), 0, "before: seller claimable 0");
        assertEq(gavelLot.ownerOf(tokenId), address(house.lotVault()), "before: vault holds NFT");
        house.settle(lotId);
        // OFFCHAIN: payment in escrow, NFT to winner.
        assertEq(house.claimable(seller), 0, "after: seller not credited yet (escrow)");
        assertEq(gavelLot.ownerOf(tokenId), alice, "after: alice owns NFT");
    }

    function test_12_TinyLot_EndToEnd() public {
        uint256 lotId = _list(seller, 100_000, 50_000, 300);
        _bid(alice, lotId, 100_000);
        _bid(bob,   lotId, 150_000);
        _bid(carol, lotId, 200_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        assertEq(gavelLot.ownerOf(_lotTokenId(lotId)), carol, "carol wins NFT");
        // Payment in escrow, seller gets nothing yet.
        assertEq(house.claimable(seller), 0, "seller not credited yet");
        assertFalse(_lotBondReleased(lotId), "bond held");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 13 — Bond / escrow lifecycle (OFFCHAIN)
    // ══════════════════════════════════════════════════════════════════════════
    function test_13_BondLifecycle() public {
        // Part A: confirmDelivery releases escrow + bond to seller
        uint256 lotA = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, lotA, 1_000_000);
        vm.warp(_lotDeadline(lotA) + 1);
        house.settle(lotA);
        assertEq(house.claimable(seller), 0, "seller: 0 before confirmDelivery");
        assertFalse(_lotBondReleased(lotA), "bond held after hammer");

        vm.prank(alice);
        house.confirmDelivery(lotA);
        assertTrue(_lotBondReleased(lotA), "bond released");
        // Seller gets bid (1_000_000) + bond (1_000_000) = 2_000_000
        assertEq(house.claimable(seller), 2_000_000, "seller: bid + bond after confirm");

        // Part B: releaseEscrow after delivery window
        uint256 lotB = _list(seller, 1_000_000, 100_000, 300);
        _bid(bob, lotB, 1_000_000);
        vm.warp(_lotDeadline(lotB) + 1);
        house.settle(lotB);

        // Before delivery window: reverts
        vm.expectRevert("AuctionHouse: delivery window open");
        house.releaseEscrow(lotB);

        // After 7 days: succeeds
        vm.warp(_lotSettledAt(lotB) + DELIVERY_WINDOW);
        uint256 sellerBefore = house.claimable(seller);
        house.releaseEscrow(lotB);
        assertTrue(_lotBondReleased(lotB), "bond released after timeout");
        // Seller gets bid + bond = 2_000_000
        assertEq(house.claimable(seller), sellerBefore + 2_000_000, "seller gains bid+bond after releaseEscrow");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 14 — Dispute resolution (OFFCHAIN)
    // ══════════════════════════════════════════════════════════════════════════
    function test_14_DisputeResolution() public {
        // Lot A: sellerAtFault=true → buyer gets payment + bond
        uint256 lotA = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, lotA, 1_000_000);
        vm.warp(_lotDeadline(lotA) + 1);
        house.settle(lotA);
        vm.prank(alice);
        house.dispute(lotA);
        uint256 aliceBefore = house.claimable(alice);
        house.resolveDispute(lotA, true);
        // Alice gets payment (1_000_000) + bond (1_000_000)
        assertEq(house.claimable(alice), aliceBefore + 2_000_000, "alice gets payment+bond");
        assertTrue(_lotBondReleased(lotA), "bond released");

        // Lot B: sellerAtFault=false → seller gets payment + bond
        uint256 lotB = _list(seller, 1_000_000, 100_000, 300);
        _bid(bob, lotB, 1_000_000);
        vm.warp(_lotDeadline(lotB) + 1);
        house.settle(lotB);
        vm.prank(bob);
        house.dispute(lotB);
        uint256 sellerBefore = house.claimable(seller);
        house.resolveDispute(lotB, false);
        assertEq(house.claimable(seller), sellerBefore + 2_000_000, "seller gets payment+bond");

        // Lot C: resolveDisputeTimeout (50/50 split, bond to seller)
        uint256 lotC = _list(seller, 1_000_000, 100_000, 300);
        _bid(carol, lotC, 1_000_000);
        vm.warp(_lotDeadline(lotC) + 1);
        house.settle(lotC);
        vm.prank(carol);
        house.dispute(lotC);
        vm.expectRevert("AuctionHouse: arbitration window open");
        house.resolveDisputeTimeout(lotC);
        vm.warp(_lotSettledAt(lotC) + DISPUTE_RESOLVE_TIMEOUT);
        uint256 sellerBefore2 = house.claimable(seller);
        uint256 carolBefore = house.claimable(carol);
        house.resolveDisputeTimeout(lotC);
        // Payment=1_000_000: buyer gets 500_000, seller gets 500_000 + bond(1_000_000)
        assertEq(house.claimable(carol), carolBefore + 500_000, "carol gets half");
        assertEq(house.claimable(seller), sellerBefore2 + 1_500_000, "seller gets half+bond");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 15 — Accounting invariant (OFFCHAIN)
    // house USDC balance == sumClaimable + active bids + active bonds + held escrow
    // ══════════════════════════════════════════════════════════════════════════
    function test_15_AccountingInvariant() public {
        uint256 lotId1 = _list(seller, 1_000_000, 100_000, 3600);
        _assertInvariant("after list");
        _bid(alice, lotId1, 1_000_000);
        _assertInvariant("after alice bid");
        _bid(bob, lotId1, 1_100_000);
        _assertInvariant("after bob outbid alice");
        vm.warp(_lotDeadline(lotId1) + 1);
        house.settle(lotId1);
        _assertInvariant("after settle lot1");
        // releaseEscrow after 7 days
        vm.warp(_lotSettledAt(lotId1) + DELIVERY_WINDOW);
        house.releaseEscrow(lotId1);
        _assertInvariant("after releaseEscrow lot1");
        vm.prank(alice);
        house.claim();
        _assertInvariant("after alice claim");
        vm.prank(seller);
        house.claim();
        _assertInvariant("after seller claim");
        // cancel lot
        uint256 lotId2 = _list(seller, 500_000, 50_000, 300);
        _assertInvariant("after list lot2");
        vm.prank(seller);
        house.cancel(lotId2);
        _assertInvariant("after cancel lot2");
        vm.prank(seller);
        house.claim();
        _assertInvariant("after seller claims cancel bond");
        // unsold lot
        uint256 lotId3 = _list(seller, 200_000, 20_000, 300);
        _assertInvariant("after list lot3");
        vm.warp(_lotDeadline(lotId3) + 1);
        house.settle(lotId3);
        _assertInvariant("after unsold settle lot3");
    }

    /// @dev Accounting invariant for OFFCHAIN lots.
    ///      house_USDC == sumClaimable + active bids + active bonds + escrowed payments
    function _assertInvariant(string memory label) internal view {
        uint256 houseBalance = usdc.balanceOf(address(house));
        address[7] memory knownAddrs = [seller, alice, bob, carol, dave, address(this), address(house)];
        uint256 sumClaimable;
        for (uint256 i = 0; i < knownAddrs.length; i++) {
            sumClaimable += house.claimable(knownAddrs[i]);
        }
        uint256 sumActiveBids;
        uint256 sumActiveBonds;
        uint256 sumEscrow;
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
            AuctionHouse.EscrowState es = house.escrowState(id);
            if (isOpen) {
                sumActiveBonds += bond;
                sumActiveBids  += highestBid;
            } else if (settled && !bondReleased) {
                sumActiveBonds += bond;
            }
            // Held escrow: payment held for the winner.
            if (es == AuctionHouse.EscrowState.HELD || es == AuctionHouse.EscrowState.DISPUTED) {
                sumEscrow += highestBid;
            }
        }
        uint256 expected = sumClaimable + sumActiveBids + sumActiveBonds + sumEscrow;
        assertEq(houseBalance, expected, string.concat("invariant: ", label));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 16 — Reentrancy on claim is blocked
    // ══════════════════════════════════════════════════════════════════════════
    function test_16_ReentrancyOnClaim() public {
        ReentrancyAttacker attacker = new ReentrancyAttacker(house);
        usdc.setTransferHook(address(attacker));
        uint256 lotId = _list(seller, 1_000_000, 100_000, 300);
        usdc.mint(address(attacker), 1_000_000);
        vm.startPrank(address(attacker));
        usdc.approve(address(house), 1_000_000);
        house.bid(lotId, 1_000_000);
        vm.stopPrank();
        _bid(bob, lotId, 1_100_000);
        assertEq(house.claimable(address(attacker)), 1_000_000, "attacker has claimable");
        attacker.doClaim();
        assertTrue(attacker.reentered(),     "hook was called");
        assertTrue(attacker.reentryReverted(), "reentry blocked");
        assertEq(usdc.balanceOf(address(attacker)), 1_000_000, "attacker received funds once");
        assertEq(house.claimable(address(attacker)), 0, "attacker claimable drained");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 17 — Pause behaviour
    // ══════════════════════════════════════════════════════════════════════════
    function test_17_PauseBehaviour() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 3600);
        _bid(alice, lotId, 1_000_000);
        _bid(bob,   lotId, 1_100_000);
        house.pause();
        usdc.mint(seller, 1_000_000);
        vm.startPrank(seller);
        usdc.approve(address(house), 1_000_000);
        vm.expectRevert("AuctionHouse: paused");
        house.list(AuctionHouse.Kind.OFFCHAIN, address(0), 0, 0, "ipfs://paused", 1_000_000, 300, 100_000);
        vm.stopPrank();
        usdc.mint(carol, 1_200_000);
        vm.startPrank(carol);
        usdc.approve(address(house), 1_200_000);
        vm.expectRevert("AuctionHouse: paused");
        house.bid(lotId, 1_200_000);
        vm.stopPrank();
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId); // settle still works
        vm.prank(alice);
        house.claim();
        // confirmDelivery still works while paused (winner is bob)
        vm.prank(bob);
        house.confirmDelivery(lotId);
        // dispute/resolve: create and settle a new lot first
        house.unpause();
        uint256 lotId2 = _list(seller, 1_000_000, 100_000, 300);
        _bid(dave, lotId2, 1_000_000);
        vm.warp(_lotDeadline(lotId2) + 1);
        house.settle(lotId2);
        house.pause();
        vm.prank(dave);
        house.dispute(lotId2);
        house.resolveDispute(lotId2, false);
        // releaseEscrow (no dispute) still works while paused
        house.unpause();
        uint256 lotId3 = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, lotId3, 1_000_000);
        vm.warp(_lotDeadline(lotId3) + 1);
        house.settle(lotId3);
        house.pause();
        vm.warp(_lotSettledAt(lotId3) + BOND_TIMEOUT);
        house.releaseEscrow(lotId3);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 18 — Cancel
    // ══════════════════════════════════════════════════════════════════════════
    function test_18_Cancel() public {
        uint256 lotA = _list(seller, 1_000_000, 100_000, 3600);
        uint256 tokenIdA = _lotTokenId(lotA);
        assertEq(gavelLot.ownerOf(tokenIdA), address(house.lotVault()), "vault holds NFT before cancel");
        vm.prank(seller);
        house.cancel(lotA);
        assertTrue(_lotCancelled(lotA), "lot cancelled");
        assertEq(house.claimable(seller), 1_000_000, "seller bond returned via claimable");
        // OFFCHAIN cancel: vault still holds NFT, seller must call claimLotAsset.
        // After cancel with no bids the lot is isUnsold (cancelled=true, highestBidder=0).
        vm.prank(seller);
        house.claimLotAsset(lotA, seller);
        assertEq(gavelLot.ownerOf(tokenIdA), seller, "seller gets NFT after cancel+claim");

        uint256 lotB = _list(seller, 1_000_000, 100_000, 3600);
        _bid(alice, lotB, 1_000_000);
        vm.prank(seller);
        vm.expectRevert("AuctionHouse: already has bids");
        house.cancel(lotB);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // bidWithAuthorization helpers (Tests 19–25)
    // ══════════════════════════════════════════════════════════════════════════
    function _computeNonce(uint256 lotId, uint256 amount, bytes32 salt) internal view returns (bytes32) {
        return keccak256(abi.encode(address(house), block.chainid, lotId, amount, salt));
    }
    function _usdcDomainSep() internal view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("Mock USDC")),
            keccak256(bytes("2")),
            block.chainid,
            USDC_ADDR
        ));
    }
    function _signReceiveAuth(
        uint256 privKey, address from, address to, uint256 value,
        uint256 validAfter, uint256 validBefore, bytes32 nonce
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(abi.encode(
            keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"),
            from, to, value, validAfter, validBefore, nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _usdcDomainSep(), structHash));
        (v, r, s) = vm.sign(privKey, digest);
    }
    function _relayedBidSigned(
        address relayer, uint256 bidderPrivKey, uint256 lotId, uint256 amount,
        uint256 validAfter, uint256 validBefore, bytes32 salt
    ) internal {
        address from = vm.addr(bidderPrivKey);
        bytes32 nonce = _computeNonce(lotId, amount, salt);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(bidderPrivKey, from, address(house), amount, validAfter, validBefore, nonce);
        usdc.mint(from, amount);
        vm.prank(relayer);
        house.bidWithAuthorization(lotId, amount, from, validAfter, validBefore, salt, v, r, s);
    }

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
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(bidderPrivKey, bidder, address(house), bidAmount, validAfter, validBefore, nonce);
        uint256 relayerBalBefore = usdc.balanceOf(relayer);
        usdc.mint(bidder, bidAmount);
        vm.expectEmit(true, true, true, true, address(house));
        emit AuctionHouse.RelayedBid(lotId, bidder, relayer, bidAmount);
        vm.prank(relayer);
        house.bidWithAuthorization(lotId, bidAmount, bidder, validAfter, validBefore, salt, v, r, s);
        assertEq(_lotHighestBidder(lotId), bidder, "bidder is highestBidder");
        assertEq(_lotHighestBid(lotId), bidAmount, "highestBid matches");
        assertEq(usdc.balanceOf(relayer), relayerBalBefore, "relayer balance unchanged");
        assertEq(usdc.balanceOf(bidder), 0, "bidder USDC consumed");
    }

    function test_20_RelayedBid_WrongLotId_Reverts() public {
        uint256 bidderPrivKey = 0xB1DD4;
        address bidder        = vm.addr(bidderPrivKey);
        address relayer       = makeAddr("relayer");
        uint256 lotId0 = _list(seller, 1_000_000, 100_000, 3600);
        uint256 lotId1 = _list(seller, 1_000_000, 100_000, 3600);
        assertEq(lotId0, 0, "lotId0");
        assertEq(lotId1, 1, "lotId1");
        uint256 bidAmount = 1_000_000; uint256 vb = block.timestamp + 3600; bytes32 salt = keccak256("salt-20");
        bytes32 nonceForLot0 = _computeNonce(lotId0, bidAmount, salt);
        usdc.mint(bidder, bidAmount);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(bidderPrivKey, bidder, address(house), bidAmount, 0, vb, nonceForLot0);
        vm.prank(relayer);
        vm.expectRevert("MockUSDC: invalid signature");
        house.bidWithAuthorization(lotId1, bidAmount, bidder, 0, vb, salt, v, r, s);
    }

    function test_21_RelayedBid_WrongAmount_Reverts() public {
        uint256 bidderPrivKey = 0xB1DD5; address bidder = vm.addr(bidderPrivKey); address relayer = makeAddr("relayer");
        uint256 lotId = _list(seller, 1_000_000, 100_000, 3600);
        uint256 signedAmount = 1_000_000; uint256 tamperedAmount = signedAmount + 1;
        uint256 vb = block.timestamp + 3600; bytes32 salt = keccak256("salt-21");
        bytes32 nonceForCorrectAmount = _computeNonce(lotId, signedAmount, salt);
        usdc.mint(bidder, tamperedAmount);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(bidderPrivKey, bidder, address(house), signedAmount, 0, vb, nonceForCorrectAmount);
        vm.prank(relayer);
        vm.expectRevert("MockUSDC: invalid signature");
        house.bidWithAuthorization(lotId, tamperedAmount, bidder, 0, vb, salt, v, r, s);
    }

    function test_22_RelayedBid_Replay_Reverts() public {
        uint256 bidderPrivKey = 0xB1DD7; address bidder = vm.addr(bidderPrivKey); address relayer = makeAddr("relayer22");
        uint256 lotId = _list(seller, 1_000_000, 100_000, 3600);
        uint256 bidAmount = 1_000_000; bytes32 salt = keccak256("salt-22"); uint256 vb = block.timestamp + 3600;
        _relayedBidSigned(relayer, bidderPrivKey, lotId, bidAmount, 0, vb, salt);
        bytes32 usedNonce = _computeNonce(lotId, bidAmount, salt);
        assertTrue(usdc.authorizationState(bidder, usedNonce), "nonce used");
        bytes32 nonce = _computeNonce(lotId, bidAmount, salt);
        (uint8 v2, bytes32 r2, bytes32 s2) = _signReceiveAuth(bidderPrivKey, bidder, address(house), bidAmount, 0, vb, nonce);
        usdc.mint(bidder, bidAmount);
        vm.prank(address(house));
        vm.expectRevert("MockUSDC: nonce used");
        usdc.receiveWithAuthorization(bidder, address(house), bidAmount, 0, vb, usedNonce, v2, r2, s2);
    }

    function test_23_RelayedBid_WrongContract_Reverts() public {
        uint256 bidderPrivKey = 0xB1DD6; address bidder = vm.addr(bidderPrivKey); address relayer = makeAddr("relayer");
        uint256 lotId = _list(seller, 1_000_000, 100_000, 3600);
        uint256 bidAmount = 1_000_000; uint256 vb = block.timestamp + 3600; bytes32 salt = keccak256("salt-23");
        address fakeHouse = makeAddr("fakeHouse");
        bytes32 nonceForFakeHouse = keccak256(abi.encode(fakeHouse, block.chainid, lotId, bidAmount, salt));
        usdc.mint(bidder, bidAmount);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(bidderPrivKey, bidder, address(house), bidAmount, 0, vb, nonceForFakeHouse);
        vm.prank(relayer);
        vm.expectRevert("MockUSDC: invalid signature");
        house.bidWithAuthorization(lotId, bidAmount, bidder, 0, vb, salt, v, r, s);
    }

    function test_24_RelayedBid_ExpiredValidBefore_Reverts() public {
        uint256 bidderPrivKey = 0xB1DD8; address bidder = vm.addr(bidderPrivKey); address relayer = makeAddr("relayer24");
        uint256 lotId = _list(seller, 1_000_000, 100_000, 3600);
        uint256 bidAmount = 1_000_000; bytes32 salt = keccak256("salt-24");
        uint256 expiredBefore = block.timestamp - 1;
        bytes32 nonce = _computeNonce(lotId, bidAmount, salt);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(bidderPrivKey, bidder, address(house), bidAmount, 0, expiredBefore, nonce);
        usdc.mint(bidder, bidAmount);
        vm.prank(relayer);
        vm.expectRevert("MockUSDC: expired");
        house.bidWithAuthorization(lotId, bidAmount, bidder, 0, expiredBefore, salt, v, r, s);
    }

    function test_25_RelayedBid_SoftClose_AndRefund() public {
        uint256 bidder1PrivKey = 0xB1DD9; uint256 bidder2PrivKey = 0xB1DDA;
        address bidder1 = vm.addr(bidder1PrivKey); address bidder2 = vm.addr(bidder2PrivKey);
        address relayer = makeAddr("relayer25");
        uint256 lotId = _list(seller, 1_000_000, 100_000, 15);
        uint256 firstBid = 1_000_000; uint256 secondBid = 1_100_000;
        bytes32 salt1 = keccak256("salt-25-bid1"); bytes32 salt2 = keccak256("salt-25-bid2");
        vm.warp(_lotDeadline(lotId) - 8);
        uint256 vb = block.timestamp + 3600;
        _relayedBidSigned(relayer, bidder1PrivKey, lotId, firstBid, 0, vb, salt1);
        assertEq(_lotExtensions(lotId), 1, "extensions == 1");
        assertGt(_lotDeadline(lotId), block.timestamp, "deadline in future");
        assertEq(_lotHighestBidder(lotId), bidder1, "bidder1 winning");
        _relayedBidSigned(relayer, bidder2PrivKey, lotId, secondBid, 0, vb, salt2);
        assertEq(house.claimable(bidder1), firstBid, "bidder1 claimable after outbid");
        assertEq(_lotHighestBidder(lotId), bidder2, "bidder2 winning");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ReputationWriter helpers (Tests 26–33)
    // ══════════════════════════════════════════════════════════════════════════
    function _deployRW() internal returns (
        ReputationWriter rw, MockIdentityRegistry mockIdentity, MockReputationRegistry mockReputation
    ) {
        mockIdentity   = new MockIdentityRegistry();
        mockReputation = new MockReputationRegistry();
        rw = new ReputationWriter(address(this), address(house), address(mockIdentity), address(mockReputation));
        house.setReputationWriter(address(rw));
    }

    function _listBidSettleConfirm(address _seller, address buyer, uint256 reserve) internal returns (uint256 lotId) {
        lotId = house.nextLotId();
        usdc.mint(_seller, reserve);
        vm.startPrank(_seller);
        usdc.approve(address(house), reserve);
        house.list(AuctionHouse.Kind.OFFCHAIN, address(0), 0, 0, "ipfs://rw-test", reserve, 3600, 1);
        vm.stopPrank();
        _bid(buyer, lotId, reserve);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        vm.prank(buyer);
        house.confirmDelivery(lotId);
    }

    function test_26_RecordSale_OnlyAfterBondReleased() public {
        (ReputationWriter rw,,) = _deployRW();
        uint256 lotId = house.nextLotId();
        usdc.mint(seller, 1_000_000);
        vm.startPrank(seller);
        usdc.approve(address(house), 1_000_000);
        house.list(AuctionHouse.Kind.OFFCHAIN, address(0), 0, 0, "ipfs://t26", 1_000_000, 3600, 1);
        vm.stopPrank();
        _bid(alice, lotId, 1_000_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        vm.expectRevert("ReputationWriter: bond not released");
        rw.recordSale(lotId);
        vm.prank(alice);
        house.confirmDelivery(lotId);
        rw.recordSale(lotId);
        assertEq(rw.cleanSales(seller), 1, "cleanSales == 1");
    }

    function test_27_RecordSale_AlreadyRecorded_Reverts() public {
        (ReputationWriter rw,,) = _deployRW();
        uint256 lotId = _listBidSettleConfirm(seller, alice, 1_000_000);
        rw.recordSale(lotId);
        vm.expectRevert("ReputationWriter: already recorded");
        rw.recordSale(lotId);
    }

    function test_28_RecordSale_Negative_OnDispute() public {
        (ReputationWriter rw, MockIdentityRegistry mockIdentity, MockReputationRegistry mockReputation) = _deployRW();
        uint256 lotId = house.nextLotId();
        usdc.mint(seller, 1_000_000);
        vm.startPrank(seller);
        usdc.approve(address(house), 1_000_000);
        house.list(AuctionHouse.Kind.OFFCHAIN, address(0), 0, 0, "ipfs://t28", 1_000_000, 3600, 1);
        vm.stopPrank();
        _bid(alice, lotId, 1_000_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        vm.prank(alice);
        house.dispute(lotId);
        house.resolveDispute(lotId, true);
        vm.prank(seller); uint256 agentId = mockIdentity.register();
        vm.prank(seller); rw.linkSeller(agentId);
        rw.recordSale(lotId);
        assertEq(rw.cleanSales(seller), 0, "disputed: cleanSales stays 0");
        assertEq(mockReputation.callCount(), 1, "giveFeedback called");
        assertEq(mockReputation.lastValue(), -1, "feedback -1");
        assertTrue(rw.lotRecorded(lotId), "lot recorded");
    }

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

    function test_30_BondDiscount_After3CleanSales() public {
        (ReputationWriter rw,,) = _deployRW();
        uint256 reserve = 200_000;
        for (uint256 i = 0; i < 3; i++) {
            uint256 lotId = _listBidSettleConfirm(seller, alice, reserve);
            rw.recordSale(lotId);
        }
        assertEq(rw.cleanSales(seller), 3, "3 clean sales");
        uint256 newLotId = house.nextLotId();
        usdc.mint(seller, reserve);
        vm.startPrank(seller);
        usdc.approve(address(house), reserve);
        house.list(AuctionHouse.Kind.OFFCHAIN, address(0), 0, 0, "ipfs://t30-discounted", reserve, 3600, 1);
        vm.stopPrank();
        assertEq(_lotBond(newLotId), reserve / 2, "bond 50% after 3 clean sales");
    }

    function test_31_CleanSalesViewRevert_DoesNotBlockList() public {
        MockReputationWriter mockRW = new MockReputationWriter();
        mockRW.setRevertOnCleanSales(true);
        house.setReputationWriter(address(mockRW));
        uint256 reserve = 1_000_000;
        uint256 lotId = house.nextLotId();
        usdc.mint(seller, reserve);
        vm.startPrank(seller);
        usdc.approve(address(house), reserve);
        house.list(AuctionHouse.Kind.OFFCHAIN, address(0), 0, 0, "ipfs://t31", reserve, 3600, 1);
        vm.stopPrank();
        assertEq(_lotBond(lotId), reserve, "bond full reserve when cleanSalesView reverts");
    }

    function test_32_LinkSeller_WrongOwner_Reverts() public {
        (ReputationWriter rw, MockIdentityRegistry mockIdentity,) = _deployRW();
        vm.prank(seller); uint256 agentId = mockIdentity.register();
        vm.prank(alice);
        vm.expectRevert("ReputationWriter: not agentId owner");
        rw.linkSeller(agentId);
        vm.prank(seller);
        rw.linkSeller(agentId);
        assertTrue(rw.sellerRegistered(seller), "seller registered");
        assertEq(rw.sellerAgentId(seller), agentId, "agentId stored");
    }

    function test_33_ReputationWriterUpdated_EventEmitted() public {
        address oldWriter = address(0); address newWriter = makeAddr("rw-addr");
        vm.expectEmit(true, true, false, false, address(house));
        emit AuctionHouse.ReputationWriterUpdated(oldWriter, newWriter);
        house.setReputationWriter(newWriter);
        assertEq(house.reputationWriter(), newWriter, "reputationWriter updated");
        address newerWriter = makeAddr("rw-addr-2");
        vm.expectEmit(true, true, false, false, address(house));
        emit AuctionHouse.ReputationWriterUpdated(newWriter, newerWriter);
        house.setReputationWriter(newerWriter);
        assertEq(house.reputationWriter(), newerWriter, "reputationWriter updated again");
    }

    function test_34_SellerCannotBidOwnLot_Relayed() public {
        uint256 pk = 0x5E11E4;
        address s2 = vm.addr(pk);
        uint256 lotId = _list(s2, 1_000_000, 1, 3600);
        bytes32 salt = keccak256("salt-34"); uint256 vb = block.timestamp + 3600;
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
        // OFFCHAIN: payment in escrow, seller gets 0 until confirmDelivery or releaseEscrow.
        assertEq(house.claimable(seller), 0, "seller not credited yet");
    }

    function test_37_FundsConservation_FullLifecycle() public {
        uint256 lotId = _list(seller, 700_000, 280_000, 3600);
        _bid(alice, lotId, 700_000);
        _bid(bob,   lotId, 980_000);
        _bid(alice, lotId, 1_260_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        // alice wins; confirmDelivery releases escrow + bond.
        vm.prank(alice);
        house.confirmDelivery(lotId);
        vm.prank(alice); house.claim();
        vm.prank(bob);   house.claim();
        vm.prank(seller); house.claim();
        // alice: 700_000 (first bid refund) + nothing else (she won)
        assertEq(usdc.balanceOf(alice), 700_000, "alice: first bid back");
        assertEq(usdc.balanceOf(bob), 980_000, "bob: full refund");
        // seller: winning bid (1_260_000) + bond (700_000) = 1_960_000
        assertEq(usdc.balanceOf(seller), 1_960_000, "seller: bid+bond");
        assertEq(usdc.balanceOf(address(house)), 0, "house holds nothing");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // v7 Tests
    // ══════════════════════════════════════════════════════════════════════════

    // ── ERC721 lot helpers ─────────────────────────────────────────────────────
    function _deployAndAllowERC721() internal returns (MockERC721 nft) {
        nft = new MockERC721();
        house.setAllowedAsset(address(nft), AuctionHouse.Kind.ERC721, true);
    }

    function _listERC721(address _seller, MockERC721 nft, uint256 tokenId, uint256 reserve, uint256 dur)
        internal returns (uint256 lotId)
    {
        lotId = house.nextLotId();
        vm.startPrank(_seller);
        nft.setApprovalForAll(address(house), true);
        house.list(AuctionHouse.Kind.ERC721, address(nft), tokenId, 0, "ipfs://nft", reserve, dur, 1);
        vm.stopPrank();
    }

    // ── ERC1155 helpers ────────────────────────────────────────────────────────
    function _deployAndAllowERC1155() internal returns (MockERC1155 tok) {
        tok = new MockERC1155();
        house.setAllowedAsset(address(tok), AuctionHouse.Kind.ERC1155, true);
    }

    function _listERC1155(address _seller, MockERC1155 tok, uint256 id, uint256 amount, uint256 reserve, uint256 dur)
        internal returns (uint256 lotId)
    {
        lotId = house.nextLotId();
        vm.startPrank(_seller);
        tok.setApprovalForAll(address(house), true);
        house.list(AuctionHouse.Kind.ERC1155, address(tok), id, amount, "ipfs://1155", reserve, dur, 1);
        vm.stopPrank();
    }

    // ── ERC20 helpers ──────────────────────────────────────────────────────────
    function _deployAndAllowERC20() internal returns (MockERC20 tok) {
        tok = new MockERC20("Test20", "T20", 18);
        house.setAllowedAsset(address(tok), AuctionHouse.Kind.ERC20, true);
    }

    function _listERC20(address _seller, MockERC20 tok, uint256 amount, uint256 reserve, uint256 dur)
        internal returns (uint256 lotId)
    {
        lotId = house.nextLotId();
        vm.startPrank(_seller);
        tok.approve(address(house), amount);
        house.list(AuctionHouse.Kind.ERC20, address(tok), 0, amount, "ipfs://erc20", reserve, dur, 1);
        vm.stopPrank();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 38 — ERC721 lot: list, bid, settle, winner claims to another address
    // ══════════════════════════════════════════════════════════════════════════
    function test_38_ERC721_ListBidSettleClaim() public {
        MockERC721 nft = _deployAndAllowERC721();
        uint256 tokenId = nft.mint(seller);
        uint256 lotId = _listERC721(seller, nft, tokenId, 500_000, 3600);
        assertEq(nft.ownerOf(tokenId), address(house.lotVault()), "vault holds NFT");
        _bid(alice, lotId, 500_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        assertEq(house.claimable(seller), 500_000, "seller credited immediately");
        // Alice claims to bob's address.
        address alternate = makeAddr("altWallet");
        vm.prank(alice);
        house.claimLotAsset(lotId, alternate);
        assertEq(nft.ownerOf(tokenId), alternate, "NFT to alternate wallet");
        // Double claim reverts.
        vm.prank(alice);
        vm.expectRevert("AuctionHouse: already claimed");
        house.claimLotAsset(lotId, alice);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 39 — ERC721 lot: unsold seller reclaims; cancel returns asset
    // ══════════════════════════════════════════════════════════════════════════
    function test_39_ERC721_UnsoldAndCancel() public {
        MockERC721 nft = _deployAndAllowERC721();
        // Unsold: settle with no bids, seller claims asset.
        uint256 tid1 = nft.mint(seller);
        uint256 lot1 = _listERC721(seller, nft, tid1, 100_000, 300);
        vm.warp(_lotDeadline(lot1) + 1);
        house.settle(lot1);
        vm.prank(seller);
        house.claimLotAsset(lot1, seller);
        assertEq(nft.ownerOf(tid1), seller, "seller reclaimed NFT");
        // Cancel with no bids: seller claims asset.
        uint256 tid2 = nft.mint(seller);
        uint256 lot2 = _listERC721(seller, nft, tid2, 100_000, 3600);
        vm.prank(seller);
        house.cancel(lot2);
        vm.prank(seller);
        house.claimLotAsset(lot2, seller);
        assertEq(nft.ownerOf(tid2), seller, "seller got NFT after cancel");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 40 — ERC1155 lot: list, bid, settle, winner claims; unsolicited rejected
    // ══════════════════════════════════════════════════════════════════════════
    function test_40_ERC1155_ListBidSettleClaim() public {
        MockERC1155 tok = _deployAndAllowERC1155();
        tok.mint(seller, 1, 50);
        uint256 lotId = _listERC1155(seller, tok, 1, 50, 200_000, 3600);
        assertEq(tok.balanceOf(address(house.lotVault()), 1), 50, "vault holds tokens");
        _bid(carol, lotId, 200_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        assertEq(house.claimable(seller), 200_000, "seller credited");
        address tokRecipient = makeAddr("1155recipient");
        vm.prank(carol);
        house.claimLotAsset(lotId, tokRecipient);
        assertEq(tok.balanceOf(tokRecipient, 1), 50, "tokRecipient received tokens");
        // Unsolicited onERC1155Received: vault guard fires; OZ v5 rethrows the revert reason.
        address outsider = makeAddr("outsider");
        address vault = address(house.lotVault()); // precompute — lotVault() call must not be the "next call" after expectRevert
        tok.mint(outsider, 1, 5);
        vm.prank(outsider);
        vm.expectRevert("LotVault: unexpected ERC1155");
        tok.safeTransferFrom(outsider, vault, 1, 1, "");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 41 — ERC20 lot: list, bid, settle, winner claims; unsold seller reclaims
    // ══════════════════════════════════════════════════════════════════════════
    function test_41_ERC20_ListBidSettleClaim() public {
        MockERC20 tok = _deployAndAllowERC20();
        tok.mint(seller, 1_000 ether);
        uint256 lotId = _listERC20(seller, tok, 1_000 ether, 300_000, 3600);
        assertEq(tok.balanceOf(address(house.lotVault())), 1_000 ether, "vault holds tokens");
        _bid(bob, lotId, 300_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        assertEq(house.claimable(seller), 300_000, "seller credited");
        address alt = makeAddr("tokenRecipient");
        vm.prank(bob);
        house.claimLotAsset(lotId, alt);
        assertEq(tok.balanceOf(alt), 1_000 ether, "tokens to alt");
        // Unsold case.
        tok.mint(seller, 500 ether);
        uint256 lot2 = _listERC20(seller, tok, 500 ether, 100_000, 300);
        vm.warp(_lotDeadline(lot2) + 1);
        house.settle(lot2);
        vm.prank(seller);
        house.claimLotAsset(lot2, seller);
        assertEq(tok.balanceOf(seller), 500 ether, "seller reclaimed tokens");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 42 — Fee-on-transfer ERC20: listing reverts
    // ══════════════════════════════════════════════════════════════════════════
    function test_42_FeeOnTransfer_Reverts() public {
        FeeOnTransferMock fot = new FeeOnTransferMock();
        house.setAllowedAsset(address(fot), AuctionHouse.Kind.ERC20, true);
        fot.mint(seller, 1_000 ether);
        vm.startPrank(seller);
        fot.approve(address(house), 1_000 ether);
        vm.expectRevert("AuctionHouse: fee-on-transfer not supported");
        house.list(AuctionHouse.Kind.ERC20, address(fot), 0, 1_000 ether, "ipfs://fot", 100_000, 3600, 1);
        vm.stopPrank();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 43 — Non-allowlisted asset: listing reverts
    // ══════════════════════════════════════════════════════════════════════════
    function test_43_NonAllowlisted_Reverts() public {
        MockERC20 tok = new MockERC20("Unlisted", "UNL", 18);
        tok.mint(seller, 100 ether);
        vm.startPrank(seller);
        tok.approve(address(house), 100 ether);
        vm.expectRevert("AuctionHouse: asset not allowed");
        house.list(AuctionHouse.Kind.ERC20, address(tok), 0, 100 ether, "ipfs://unl", 100_000, 3600, 1);
        vm.stopPrank();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 44 — Blocklisting ERC20: winner claims to an alternative address
    // ══════════════════════════════════════════════════════════════════════════
    function test_44_BlocklistERC20_ClaimToAlternate() public {
        BlocklistERC20Mock blk = new BlocklistERC20Mock();
        house.setAllowedAsset(address(blk), AuctionHouse.Kind.ERC20, true);
        blk.mint(seller, 1_000 ether);
        uint256 lotId = house.nextLotId();
        vm.startPrank(seller);
        blk.approve(address(house), 1_000 ether);
        house.list(AuctionHouse.Kind.ERC20, address(blk), 0, 1_000 ether, "ipfs://blk", 100_000, 3600, 1);
        vm.stopPrank();
        _bid(alice, lotId, 100_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        // Blocklist alice's primary address.
        blk.blocklist(alice);
        // Alice cannot receive directly, but claims to a clean address.
        address cleanAddr = makeAddr("cleanAddr");
        vm.prank(alice);
        house.claimLotAsset(lotId, cleanAddr);
        assertEq(blk.balanceOf(cleanAddr), 1_000 ether, "tokens to clean address");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 45 — Double-claim reverts; non-entitled claim reverts
    // ══════════════════════════════════════════════════════════════════════════
    function test_45_DoubleClaimAndUnauthorizedClaim_Revert() public {
        MockERC721 nft = _deployAndAllowERC721();
        uint256 tokenId = nft.mint(seller);
        uint256 lotId = _listERC721(seller, nft, tokenId, 100_000, 3600);
        _bid(alice, lotId, 100_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        // bob (not winner) cannot claim
        vm.prank(bob);
        vm.expectRevert("AuctionHouse: not winner");
        house.claimLotAsset(lotId, bob);
        // alice (winner) claims once
        vm.prank(alice);
        house.claimLotAsset(lotId, alice);
        // double claim
        vm.prank(alice);
        vm.expectRevert("AuctionHouse: already claimed");
        house.claimLotAsset(lotId, alice);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 46 — OFFCHAIN escrow: refundBuyer
    // ══════════════════════════════════════════════════════════════════════════
    function test_46_OFFCHAIN_RefundBuyer() public {
        uint256 lotId = _list(seller, 500_000, 1, 3600);
        _bid(alice, lotId, 500_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        uint256 aliceBefore = house.claimable(alice);
        uint256 sellerBefore = house.claimable(seller);
        vm.prank(seller);
        house.refundBuyer(lotId);
        // Alice gets payment back; seller gets bond.
        assertEq(house.claimable(alice), aliceBefore + 500_000, "alice refunded");
        assertEq(house.claimable(seller), sellerBefore + 500_000, "seller gets bond");
        assertTrue(_lotBondReleased(lotId), "bond released");
        assertEq(uint8(house.escrowState(lotId)), uint8(AuctionHouse.EscrowState.CLOSED), "escrow CLOSED");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 47 — OFFCHAIN escrow: releaseEscrow while disputed reverts
    // ══════════════════════════════════════════════════════════════════════════
    function test_47_OFFCHAIN_ReleaseEscrowDuringDispute_Reverts() public {
        uint256 lotId = _list(seller, 500_000, 1, 3600);
        _bid(alice, lotId, 500_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        vm.prank(alice);
        house.dispute(lotId);
        vm.warp(_lotSettledAt(lotId) + DELIVERY_WINDOW + 1);
        vm.expectRevert("AuctionHouse: escrow not held");
        house.releaseEscrow(lotId);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 48 — OFFCHAIN escrow: dispute after window reverts
    // ══════════════════════════════════════════════════════════════════════════
    function test_48_OFFCHAIN_DisputeAfterWindow_Reverts() public {
        uint256 lotId = _list(seller, 500_000, 1, 3600);
        _bid(alice, lotId, 500_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        vm.warp(_lotSettledAt(lotId) + DELIVERY_WINDOW + 1);
        vm.prank(alice);
        vm.expectRevert("AuctionHouse: dispute window closed");
        house.dispute(lotId);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 49 — Soft close: 100 extensions still work (cap is 500)
    // ══════════════════════════════════════════════════════════════════════════
    function test_49_SoftClose_100Extensions() public {
        uint256 lotId = _list(seller, 1_000_000, 10_000, 300);
        uint256 bidAmount = 1_000_000;
        for (uint256 i = 0; i < 100; i++) {
            vm.warp(_lotDeadline(lotId) - 3);
            bidAmount += 10_000;
            _bid(address(uint160(0xCC00 + i)), lotId, bidAmount);
        }
        assertEq(_lotExtensions(lotId), 100, "100 extensions");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 50 — Reserve cap: owner-adjustable, hard cap enforced
    // ══════════════════════════════════════════════════════════════════════════
    function test_50_MaxReserve_OwnerAdjustable() public {
        // Default maxReserve = 1,000 USDC (1_000_000_000 in 6-dec).
        assertEq(house.maxReserve(), 1_000_000_000, "default maxReserve");
        // Listing at exactly maxReserve succeeds.
        uint256 mr = house.maxReserve();
        usdc.mint(seller, mr);
        vm.startPrank(seller);
        usdc.approve(address(house), mr);
        house.list(AuctionHouse.Kind.OFFCHAIN, address(0), 0, 0, "ipfs://max", mr, 3600, 1);
        vm.stopPrank();
        // Listing above maxReserve reverts.
        uint256 tooHigh = mr + 1;
        usdc.mint(seller, tooHigh);
        vm.startPrank(seller);
        usdc.approve(address(house), tooHigh);
        vm.expectRevert("AuctionHouse: reserve too high");
        house.list(AuctionHouse.Kind.OFFCHAIN, address(0), 0, 0, "ipfs://over", tooHigh, 3600, 1);
        vm.stopPrank();
        // Owner raises maxReserve to 10,000 USDC.
        house.setMaxReserve(10_000_000_000);
        assertEq(house.maxReserve(), 10_000_000_000, "maxReserve updated");
        // Listing above hard cap reverts (owner-only, no prank needed — test contract is owner).
        uint256 overCap = house.MAX_RESERVE_CAP() + 1; // precompute to avoid the getter call consuming expectRevert
        vm.expectRevert("AuctionHouse: invalid max reserve");
        house.setMaxReserve(overCap);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 51 — No step cap: large minIncrement accepted
    // ══════════════════════════════════════════════════════════════════════════
    function test_51_NoStepCap() public {
        uint256 bigStep = 999_000_000; // 999 USDC step — no cap
        usdc.mint(seller, 1_000_000);
        vm.startPrank(seller);
        usdc.approve(address(house), 1_000_000);
        uint256 lotId = house.nextLotId();
        house.list(AuctionHouse.Kind.OFFCHAIN, address(0), 0, 0, "ipfs://bigstep", 1_000_000, 3600, bigStep);
        vm.stopPrank();
        assertEq(_lotMinIncrement(lotId), bigStep, "big step stored");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 52 — Funds conservation across all kinds (ERC721, ERC1155, ERC20, OFFCHAIN)
    // ══════════════════════════════════════════════════════════════════════════
    function test_52_FundsConservation_AllKinds() public {
        // ERC721 lot
        MockERC721 nft = _deployAndAllowERC721();
        uint256 tid = nft.mint(seller);
        uint256 lot1 = _listERC721(seller, nft, tid, 100_000, 3600);
        _bid(alice, lot1, 100_000);
        vm.warp(_lotDeadline(lot1) + 1);
        house.settle(lot1);
        vm.prank(alice); house.claimLotAsset(lot1, alice);
        vm.prank(seller); house.claim();
        assertEq(usdc.balanceOf(address(house)), 0, "house empty after ERC721 lot");

        // ERC20 lot
        MockERC20 tok = _deployAndAllowERC20();
        tok.mint(seller, 500 ether);
        uint256 lot2 = _listERC20(seller, tok, 500 ether, 200_000, 3600);
        _bid(bob, lot2, 200_000);
        vm.warp(_lotDeadline(lot2) + 1);
        house.settle(lot2);
        vm.prank(bob); house.claimLotAsset(lot2, bob);
        vm.prank(seller); house.claim();
        assertEq(usdc.balanceOf(address(house)), 0, "house empty after ERC20 lot");

        // OFFCHAIN lot with confirmDelivery
        uint256 lot3 = _list(seller, 300_000, 1, 3600);
        _bid(carol, lot3, 300_000);
        vm.warp(_lotDeadline(lot3) + 1);
        house.settle(lot3);
        vm.prank(carol); house.confirmDelivery(lot3);
        vm.prank(seller); house.claim();
        assertEq(usdc.balanceOf(address(house)), 0, "house empty after OFFCHAIN lot");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 53 — 50/50 split with odd amount: sum is exact
    // ══════════════════════════════════════════════════════════════════════════
    function test_53_DisputeTimeout_OddAmount_ExactSplit() public {
        uint256 reserve = 1_000_001; // odd number
        usdc.mint(seller, reserve);
        vm.startPrank(seller);
        usdc.approve(address(house), reserve);
        uint256 lotId = house.nextLotId();
        house.list(AuctionHouse.Kind.OFFCHAIN, address(0), 0, 0, "ipfs://odd", reserve, 3600, 1);
        vm.stopPrank();
        _bid(alice, lotId, reserve);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        vm.prank(alice);
        house.dispute(lotId);
        vm.warp(_lotSettledAt(lotId) + DISPUTE_RESOLVE_TIMEOUT);
        uint256 sellerBefore = house.claimable(seller);
        uint256 aliceBefore = house.claimable(alice);
        house.resolveDisputeTimeout(lotId);
        uint256 buyerShare = reserve / 2;           // floor
        uint256 sellerShare = reserve - buyerShare; // the rest
        assertEq(house.claimable(alice),  aliceBefore + buyerShare,                 "buyer gets floor(x/2)");
        assertEq(house.claimable(seller), sellerBefore + sellerShare + reserve,     "seller gets rest+bond");
        // Total credited == payment + bond
        assertEq(buyerShare + sellerShare, reserve, "split sums to payment exactly");
    }

    // ── Audit regressions (manual review of turn 23) ──────────────────────────

    /// C1: a stranger must not be able to strand an escrowed payment. The only
    ///     no-dispute exit after the window is releaseEscrow, which pays seller
    ///     payment + bond exactly once.
    function test_54_Escrow_StrangerCannotStrandPayment() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, lotId, 3_000_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        assertEq(house.claimable(seller), 0, "nothing to seller while escrow held");
        vm.warp(_lotSettledAt(lotId) + 7 days);
        vm.prank(carol);                       // a stranger triggers the release
        house.releaseEscrow(lotId);
        assertEq(house.claimable(seller), 3_000_000 + 1_000_000, "seller gets payment + bond");
        vm.expectRevert("AuctionHouse: bond released");
        house.releaseEscrow(lotId);            // cannot pay twice
        vm.prank(seller); house.claim();
        assertEq(usdc.balanceOf(address(house)), 0, "house empty after the only exit");
    }

    /// H1: the arbitration timeout runs from the dispute, not from the sale.
    function test_55_DisputeTimeout_CountsFromDispute() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, lotId, 2_000_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        uint256 settledAt = _lotSettledAt(lotId);
        vm.warp(settledAt + 6 days);
        vm.prank(alice); house.dispute(lotId);
        vm.warp(settledAt + 14 days);          // 14 days after the sale, only 8 after the dispute
        vm.expectRevert("AuctionHouse: arbitration window open");
        house.resolveDisputeTimeout(lotId);
        vm.warp(settledAt + 6 days + 14 days); // 14 days after the dispute
        house.resolveDisputeTimeout(lotId);
        assertEq(house.claimable(alice), 1_000_000, "buyer half");
        assertEq(house.claimable(seller), 1_000_000 + 1_000_000, "seller half + bond");
    }

    /// Escrow paths: confirm pays seller; seller-at-fault refunds buyer + bond.
    function test_56_Escrow_ConfirmAndSellerAtFault() public {
        uint256 a = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, a, 2_000_000);
        vm.warp(_lotDeadline(a) + 1);
        house.settle(a);
        vm.prank(alice); house.confirmDelivery(a);
        assertEq(house.claimable(seller), 3_000_000, "confirm: payment + bond to seller");

        uint256 b = _list(seller, 1_000_000, 100_000, 300);
        _bid(bob, b, 4_000_000);
        vm.warp(_lotDeadline(b) + 1);
        house.settle(b);
        vm.prank(bob); house.dispute(b);
        vm.expectRevert("AuctionHouse: escrow not held");
        house.releaseEscrow(b);
        house.resolveDispute(b, true);
        assertEq(house.claimable(bob), 4_000_000 + 1_000_000, "seller at fault: buyer gets payment + bond");
    }

    /// L1: the vault refuses ERC721s sent to it outside a listing.
    function test_57_Vault_RejectsStrayERC721() public {
        MockERC721 nft = new MockERC721();
        uint256 id = nft.mint(alice);
        address vault = address(house.lotVault());
        vm.prank(alice);
        vm.expectRevert("LotVault: unexpected ERC721");
        nft.safeTransferFrom(alice, vault, id);
    }

    /// T13: the vault refuses ERC1155s sent to it outside a listing.
    function test_58_Vault_RejectsUnsolicitedERC1155() public {
        MockERC1155 tok = new MockERC1155();
        tok.mint(alice, 7, 5);
        address vault = address(house.lotVault());
        vm.prank(alice);
        vm.expectRevert("LotVault: unexpected ERC1155");
        tok.safeTransferFrom(alice, vault, 7, 5, "");
    }

    /// An on-chain lot cannot be settled twice or claimed by a stranger, and the
    /// seller is paid at settle while the asset waits for the winner.
    function test_59_ERC721_SellerPaidAtSettle_AssetWaitsForWinner() public {
        MockERC721 nft = _deployAndAllowERC721();
        uint256 id = nft.mint(seller);
        uint256 lotId = _listERC721(seller, nft, id, 1_000_000, 300);
        _bid(alice, lotId, 1_500_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        assertEq(house.claimable(seller), 1_500_000, "seller paid at settle, no bond");
        assertEq(nft.ownerOf(id), address(house.lotVault()), "asset waits in vault");
        vm.prank(carol);
        vm.expectRevert("AuctionHouse: not winner");
        house.claimLotAsset(lotId, carol);
        vm.prank(alice); house.claimLotAsset(lotId, dave);   // winner sends it elsewhere
        assertEq(nft.ownerOf(id), dave, "delivered to the address the winner chose");
    }
}
