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
        assertEq(gavelLot.ownerOf(_lotTokenId(lotId)), carol, "carol should own NFT");
        assertEq(house.claimable(seller), 0, "seller not credited until escrow released");
        assertFalse(_lotBondReleased(lotId), "bond held");
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
        assertEq(house.claimable(seller), 0, "seller not credited yet");
        assertFalse(_lotBondReleased(lotId), "bond held");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 13 — Bond / escrow lifecycle (OFFCHAIN)
    // ══════════════════════════════════════════════════════════════════════════
    function test_13_BondLifecycle() public {
        uint256 lotA = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, lotA, 1_000_000);
        vm.warp(_lotDeadline(lotA) + 1);
        house.settle(lotA);
        assertEq(house.claimable(seller), 0, "seller: 0 before confirmDelivery");
        assertFalse(_lotBondReleased(lotA), "bond held after hammer");

        vm.prank(alice);
        house.confirmDelivery(lotA);
        assertTrue(_lotBondReleased(lotA), "bond released");
        // _payOut pushes directly; seller.balance == 2_000_000
        assertEq(usdc.balanceOf(seller), 2_000_000, "seller: bid + bond pushed directly");
        assertEq(house.claimable(seller), 0, "seller claimable still 0 (pushed)");

        uint256 lotB = _list(seller, 1_000_000, 100_000, 300);
        _bid(bob, lotB, 1_000_000);
        vm.warp(_lotDeadline(lotB) + 1);
        house.settle(lotB);

        vm.expectRevert("AuctionHouse: delivery window open");
        house.releaseEscrow(lotB);

        vm.warp(_lotSettledAt(lotB) + DELIVERY_WINDOW);
        uint256 sellerBalBefore = usdc.balanceOf(seller);
        house.releaseEscrow(lotB);
        assertTrue(_lotBondReleased(lotB), "bond released after timeout");
        assertEq(usdc.balanceOf(seller), sellerBalBefore + 2_000_000, "seller gains bid+bond after releaseEscrow");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 14 — Dispute resolution (OFFCHAIN)
    // ══════════════════════════════════════════════════════════════════════════
    function test_14_DisputeResolution() public {
        uint256 lotA = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, lotA, 1_000_000);
        vm.warp(_lotDeadline(lotA) + 1);
        house.settle(lotA);
        vm.prank(alice);
        house.dispute(lotA);
        uint256 aliceBalBefore = usdc.balanceOf(alice);
        house.resolveDispute(lotA, true);
        assertEq(usdc.balanceOf(alice), aliceBalBefore + 2_000_000, "alice gets payment+bond (pushed)");
        assertTrue(_lotBondReleased(lotA), "bond released");

        uint256 lotB = _list(seller, 1_000_000, 100_000, 300);
        _bid(bob, lotB, 1_000_000);
        vm.warp(_lotDeadline(lotB) + 1);
        house.settle(lotB);
        vm.prank(bob);
        house.dispute(lotB);
        uint256 sellerBalBefore = usdc.balanceOf(seller);
        house.resolveDispute(lotB, false);
        assertEq(usdc.balanceOf(seller), sellerBalBefore + 2_000_000, "seller gets payment+bond (pushed)");

        uint256 lotC = _list(seller, 1_000_000, 100_000, 300);
        _bid(carol, lotC, 1_000_000);
        vm.warp(_lotDeadline(lotC) + 1);
        house.settle(lotC);
        vm.prank(carol);
        house.dispute(lotC);
        vm.expectRevert("AuctionHouse: arbitration window open");
        house.resolveDisputeTimeout(lotC);
        vm.warp(_lotSettledAt(lotC) + DISPUTE_RESOLVE_TIMEOUT);
        uint256 sellerBefore2 = usdc.balanceOf(seller);
        uint256 carolBefore = usdc.balanceOf(carol);
        house.resolveDisputeTimeout(lotC);
        assertEq(usdc.balanceOf(carol), carolBefore + 500_000, "carol gets half (pushed)");
        assertEq(usdc.balanceOf(seller), sellerBefore2 + 1_500_000, "seller gets half+bond (pushed)");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Test 15 — Accounting invariant (OFFCHAIN)
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
        vm.warp(_lotSettledAt(lotId1) + DELIVERY_WINDOW);
        house.releaseEscrow(lotId1);
        _assertInvariant("after releaseEscrow lot1");
        vm.prank(alice);
        house.claim();
        _assertInvariant("after alice claim");
        // seller was paid out via _payOut (pushed); nothing to claim
        _assertInvariant("after seller (no claimable)");
        uint256 lotId2 = _list(seller, 500_000, 50_000, 300);
        _assertInvariant("after list lot2");
        vm.prank(seller);
        house.cancel(lotId2);
        _assertInvariant("after cancel lot2");
        vm.prank(seller);
        house.claim();
        _assertInvariant("after seller claims cancel bond");
        uint256 lotId3 = _list(seller, 200_000, 20_000, 300);
        _assertInvariant("after list lot3");
        vm.warp(_lotDeadline(lotId3) + 1);
        house.settle(lotId3);
        _assertInvariant("after unsold settle lot3");
    }

    /// @dev Accounting invariant: house USDC = sumClaimable + active bids + active bonds + held escrow
    ///      NOTE: with _payOut pushing directly to wallets, seller's released funds
    ///      no longer go into claimable — they're pushed. So after releaseEscrow/confirmDelivery
    ///      the house balance drops to 0 correctly and claimable stays clean.
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
        house.settle(lotId);
        vm.prank(alice);
        house.claim();
        vm.prank(bob);
        house.confirmDelivery(lotId);
        house.unpause();
        uint256 lotId2 = _list(seller, 1_000_000, 100_000, 300);
        _bid(dave, lotId2, 1_000_000);
        vm.warp(_lotDeadline(lotId2) + 1);
        house.settle(lotId2);
        house.pause();
        vm.prank(dave);
        house.dispute(lotId2);
        house.resolveDispute(lotId2, false);
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
    // bidWithAuthorization helpers (Tests 19–25) — v8: includes topUp param
    // ══════════════════════════════════════════════════════════════════════════
    /// @dev v8 nonce binds: AH address, chainId, lotId, amount, topUp, salt
    function _computeNonce(uint256 lotId, uint256 amount, uint256 topUp, bytes32 salt) internal view returns (bytes32) {
        return keccak256(abi.encode(address(house), block.chainid, lotId, amount, topUp, salt));
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
    /// @dev Helper: signs for the full amount (topUp = amount, no credit), relays on behalf of bidder.
    function _relayedBidSigned(
        address relayer, uint256 bidderPrivKey, uint256 lotId, uint256 amount,
        uint256 validAfter, uint256 validBefore, bytes32 salt
    ) internal {
        address from = vm.addr(bidderPrivKey);
        bytes32 nonce = _computeNonce(lotId, amount, amount, salt); // topUp == amount
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(bidderPrivKey, from, address(house), amount, validAfter, validBefore, nonce);
        usdc.mint(from, amount);
        vm.prank(relayer);
        house.bidWithAuthorization(lotId, amount, amount, from, validAfter, validBefore, salt, v, r, s);
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
        // topUp == amount (no credit)
        bytes32 nonce = _computeNonce(lotId, bidAmount, bidAmount, salt);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(bidderPrivKey, bidder, address(house), bidAmount, validAfter, validBefore, nonce);
        uint256 relayerBalBefore = usdc.balanceOf(relayer);
        usdc.mint(bidder, bidAmount);
        vm.expectEmit(true, true, true, true, address(house));
        emit AuctionHouse.RelayedBid(lotId, bidder, relayer, bidAmount);
        vm.prank(relayer);
        house.bidWithAuthorization(lotId, bidAmount, bidAmount, bidder, validAfter, validBefore, salt, v, r, s);
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
        bytes32 nonceForLot0 = _computeNonce(lotId0, bidAmount, bidAmount, salt);
        usdc.mint(bidder, bidAmount);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(bidderPrivKey, bidder, address(house), bidAmount, 0, vb, nonceForLot0);
        vm.prank(relayer);
        vm.expectRevert("MockUSDC: invalid signature");
        house.bidWithAuthorization(lotId1, bidAmount, bidAmount, bidder, 0, vb, salt, v, r, s);
    }

    function test_21_RelayedBid_WrongAmount_Reverts() public {
        uint256 bidderPrivKey = 0xB1DD5; address bidder = vm.addr(bidderPrivKey); address relayer = makeAddr("relayer");
        uint256 lotId = _list(seller, 1_000_000, 100_000, 3600);
        uint256 signedAmount = 1_000_000; uint256 tamperedAmount = signedAmount + 1;
        uint256 vb = block.timestamp + 3600; bytes32 salt = keccak256("salt-21");
        bytes32 nonceForCorrectAmount = _computeNonce(lotId, signedAmount, signedAmount, salt);
        usdc.mint(bidder, tamperedAmount);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(bidderPrivKey, bidder, address(house), signedAmount, 0, vb, nonceForCorrectAmount);
        vm.prank(relayer);
        vm.expectRevert("MockUSDC: invalid signature");
        house.bidWithAuthorization(lotId, tamperedAmount, tamperedAmount, bidder, 0, vb, salt, v, r, s);
    }

    function test_22_RelayedBid_Replay_Reverts() public {
        uint256 bidderPrivKey = 0xB1DD7; address bidder = vm.addr(bidderPrivKey); address relayer = makeAddr("relayer22");
        uint256 lotId = _list(seller, 1_000_000, 100_000, 3600);
        uint256 bidAmount = 1_000_000; bytes32 salt = keccak256("salt-22"); uint256 vb = block.timestamp + 3600;
        _relayedBidSigned(relayer, bidderPrivKey, lotId, bidAmount, 0, vb, salt);
        bytes32 usedNonce = _computeNonce(lotId, bidAmount, bidAmount, salt);
        assertTrue(usdc.authorizationState(bidder, usedNonce), "nonce used");
        bytes32 nonce = _computeNonce(lotId, bidAmount, bidAmount, salt);
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
        // nonce uses fakeHouse — will mismatch contract-derived nonce
        bytes32 nonceForFakeHouse = keccak256(abi.encode(fakeHouse, block.chainid, lotId, bidAmount, bidAmount, salt));
        usdc.mint(bidder, bidAmount);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(bidderPrivKey, bidder, address(house), bidAmount, 0, vb, nonceForFakeHouse);
        vm.prank(relayer);
        vm.expectRevert("MockUSDC: invalid signature");
        house.bidWithAuthorization(lotId, bidAmount, bidAmount, bidder, 0, vb, salt, v, r, s);
    }

    function test_24_RelayedBid_ExpiredValidBefore_Reverts() public {
        uint256 bidderPrivKey = 0xB1DD8; address bidder = vm.addr(bidderPrivKey); address relayer = makeAddr("relayer24");
        uint256 lotId = _list(seller, 1_000_000, 100_000, 3600);
        uint256 bidAmount = 1_000_000; bytes32 salt = keccak256("salt-24");
        uint256 expiredBefore = block.timestamp - 1;
        bytes32 nonce = _computeNonce(lotId, bidAmount, bidAmount, salt);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(bidderPrivKey, bidder, address(house), bidAmount, 0, expiredBefore, nonce);
        usdc.mint(bidder, bidAmount);
        vm.prank(relayer);
        vm.expectRevert("MockUSDC: expired");
        house.bidWithAuthorization(lotId, bidAmount, bidAmount, bidder, 0, expiredBefore, salt, v, r, s);
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
        bytes32 nonce = _computeNonce(lotId, 1_000_000, 1_000_000, salt);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(pk, s2, address(house), 1_000_000, 0, vb, nonce);
        usdc.mint(s2, 1_000_000);
        vm.prank(makeAddr("relayer34"));
        vm.expectRevert("AuctionHouse: seller cannot bid");
        house.bidWithAuthorization(lotId, 1_000_000, 1_000_000, s2, 0, vb, salt, v, r, s);
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
        assertEq(house.claimable(seller), 0, "seller not credited yet");
    }

    function test_37_FundsConservation_FullLifecycle() public {
        // v8: bid() uses claimable first.
        // alice bids 700_000 (from wallet), then is outbid by bob (980_000).
        // alice gets 700_000 claimable. alice raises to 1_260_000:
        //   _bidCore credits bob 980_000 (bob.claimable=980_000)
        //   alice credit = min(700_000, 1_260_000) = 700_000; topUp = 560_000
        //   _bid helper minted 1_260_000 for alice but only 560_000 is pulled via transferFrom.
        //   alice's wallet balance after second raise = 1_260_000 - 560_000 = 700_000 (the surplus from mint)
        // After settle + confirmDelivery:
        //   _payOut pushes payment+bond (1_260_000 + 700_000 = 1_960_000) to seller.
        //   alice.claimable = 0, bob.claimable = 980_000
        uint256 lotId = _list(seller, 700_000, 280_000, 3600);
        _bid(alice, lotId, 700_000);
        _bid(bob,   lotId, 980_000);   // alice outbid; alice.claimable = 700_000
        _bid(alice, lotId, 1_260_000); // alice credit 700_000 used; topUp 560_000 from wallet
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        vm.prank(alice);
        house.confirmDelivery(lotId);
        // bob claims his 980_000 refund
        vm.prank(bob); house.claim();
        // alice has NO claimable (700_000 was used as credit)
        assertEq(house.claimable(alice), 0, "alice: no claimable left");
        assertEq(usdc.balanceOf(bob), 980_000, "bob: full refund");
        // seller: winning bid + bond pushed directly
        assertEq(usdc.balanceOf(seller), 1_960_000, "seller: bid+bond");
        assertEq(usdc.balanceOf(address(house)), 0, "house holds nothing");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // v7 Tests (38-53)
    // ══════════════════════════════════════════════════════════════════════════

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

    function test_38_ERC721_ListBidSettleClaim() public {
        MockERC721 nft = _deployAndAllowERC721();
        uint256 tokenId = nft.mint(seller);
        uint256 lotId = _listERC721(seller, nft, tokenId, 500_000, 3600);
        assertEq(nft.ownerOf(tokenId), address(house.lotVault()), "vault holds NFT");
        _bid(alice, lotId, 500_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        assertEq(house.claimable(seller), 500_000, "seller credited immediately");
        address alternate = makeAddr("altWallet");
        vm.prank(alice);
        house.claimLotAsset(lotId, alternate);
        assertEq(nft.ownerOf(tokenId), alternate, "NFT to alternate wallet");
        vm.prank(alice);
        vm.expectRevert("AuctionHouse: already claimed");
        house.claimLotAsset(lotId, alice);
    }

    function test_39_ERC721_UnsoldAndCancel() public {
        MockERC721 nft = _deployAndAllowERC721();
        uint256 tid1 = nft.mint(seller);
        uint256 lot1 = _listERC721(seller, nft, tid1, 100_000, 300);
        vm.warp(_lotDeadline(lot1) + 1);
        house.settle(lot1);
        vm.prank(seller);
        house.claimLotAsset(lot1, seller);
        assertEq(nft.ownerOf(tid1), seller, "seller reclaimed NFT");
        uint256 tid2 = nft.mint(seller);
        uint256 lot2 = _listERC721(seller, nft, tid2, 100_000, 3600);
        vm.prank(seller);
        house.cancel(lot2);
        vm.prank(seller);
        house.claimLotAsset(lot2, seller);
        assertEq(nft.ownerOf(tid2), seller, "seller got NFT after cancel");
    }

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
        address outsider = makeAddr("outsider");
        address vault = address(house.lotVault());
        tok.mint(outsider, 1, 5);
        vm.prank(outsider);
        vm.expectRevert("LotVault: unexpected ERC1155");
        tok.safeTransferFrom(outsider, vault, 1, 1, "");
    }

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
        tok.mint(seller, 500 ether);
        uint256 lot2 = _listERC20(seller, tok, 500 ether, 100_000, 300);
        vm.warp(_lotDeadline(lot2) + 1);
        house.settle(lot2);
        vm.prank(seller);
        house.claimLotAsset(lot2, seller);
        assertEq(tok.balanceOf(seller), 500 ether, "seller reclaimed tokens");
    }

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

    function test_43_NonAllowlisted_Reverts() public {
        MockERC20 tok = new MockERC20("Unlisted", "UNL", 18);
        tok.mint(seller, 100 ether);
        vm.startPrank(seller);
        tok.approve(address(house), 100 ether);
        vm.expectRevert("AuctionHouse: asset not allowed");
        house.list(AuctionHouse.Kind.ERC20, address(tok), 0, 100 ether, "ipfs://unl", 100_000, 3600, 1);
        vm.stopPrank();
    }

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
        blk.blocklist(alice);
        address cleanAddr = makeAddr("cleanAddr");
        vm.prank(alice);
        house.claimLotAsset(lotId, cleanAddr);
        assertEq(blk.balanceOf(cleanAddr), 1_000 ether, "tokens to clean address");
    }

    function test_45_DoubleClaimAndUnauthorizedClaim_Revert() public {
        MockERC721 nft = _deployAndAllowERC721();
        uint256 tokenId = nft.mint(seller);
        uint256 lotId = _listERC721(seller, nft, tokenId, 100_000, 3600);
        _bid(alice, lotId, 100_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        vm.prank(bob);
        vm.expectRevert("AuctionHouse: not winner");
        house.claimLotAsset(lotId, bob);
        vm.prank(alice);
        house.claimLotAsset(lotId, alice);
        vm.prank(alice);
        vm.expectRevert("AuctionHouse: already claimed");
        house.claimLotAsset(lotId, alice);
    }

    function test_46_OFFCHAIN_RefundBuyer() public {
        uint256 lotId = _list(seller, 500_000, 1, 3600);
        _bid(alice, lotId, 500_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        uint256 aliceBalBefore = usdc.balanceOf(alice);
        uint256 sellerBalBefore = usdc.balanceOf(seller);
        vm.prank(seller);
        house.refundBuyer(lotId, "item lost in transit");
        // Alice gets payment pushed directly
        assertEq(usdc.balanceOf(alice), aliceBalBefore + 500_000, "alice refunded (pushed)");
        // Seller gets bond pushed directly
        assertEq(usdc.balanceOf(seller), sellerBalBefore + 500_000, "seller gets bond (pushed)");
        assertTrue(_lotBondReleased(lotId), "bond released");
        assertEq(uint8(house.escrowState(lotId)), uint8(AuctionHouse.EscrowState.CLOSED), "escrow CLOSED");
    }

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

    function test_50_MaxReserve_OwnerAdjustable() public {
        assertEq(house.maxReserve(), 1_000_000_000, "default maxReserve");
        uint256 mr = house.maxReserve();
        usdc.mint(seller, mr);
        vm.startPrank(seller);
        usdc.approve(address(house), mr);
        house.list(AuctionHouse.Kind.OFFCHAIN, address(0), 0, 0, "ipfs://max", mr, 3600, 1);
        vm.stopPrank();
        uint256 tooHigh = mr + 1;
        usdc.mint(seller, tooHigh);
        vm.startPrank(seller);
        usdc.approve(address(house), tooHigh);
        vm.expectRevert("AuctionHouse: reserve too high");
        house.list(AuctionHouse.Kind.OFFCHAIN, address(0), 0, 0, "ipfs://over", tooHigh, 3600, 1);
        vm.stopPrank();
        house.setMaxReserve(10_000_000_000);
        assertEq(house.maxReserve(), 10_000_000_000, "maxReserve updated");
        uint256 overCap = house.MAX_RESERVE_CAP() + 1;
        vm.expectRevert("AuctionHouse: invalid max reserve");
        house.setMaxReserve(overCap);
    }

    function test_51_NoStepCap() public {
        uint256 bigStep = 999_000_000;
        usdc.mint(seller, 1_000_000);
        vm.startPrank(seller);
        usdc.approve(address(house), 1_000_000);
        uint256 lotId = house.nextLotId();
        house.list(AuctionHouse.Kind.OFFCHAIN, address(0), 0, 0, "ipfs://bigstep", 1_000_000, 3600, bigStep);
        vm.stopPrank();
        assertEq(_lotMinIncrement(lotId), bigStep, "big step stored");
    }

    function test_52_FundsConservation_AllKinds() public {
        MockERC721 nft = _deployAndAllowERC721();
        uint256 tid = nft.mint(seller);
        uint256 lot1 = _listERC721(seller, nft, tid, 100_000, 3600);
        _bid(alice, lot1, 100_000);
        vm.warp(_lotDeadline(lot1) + 1);
        house.settle(lot1);
        vm.prank(alice); house.claimLotAsset(lot1, alice);
        vm.prank(seller); house.claim();
        assertEq(usdc.balanceOf(address(house)), 0, "house empty after ERC721 lot");

        MockERC20 tok = _deployAndAllowERC20();
        tok.mint(seller, 500 ether);
        uint256 lot2 = _listERC20(seller, tok, 500 ether, 200_000, 3600);
        _bid(bob, lot2, 200_000);
        vm.warp(_lotDeadline(lot2) + 1);
        house.settle(lot2);
        vm.prank(bob); house.claimLotAsset(lot2, bob);
        vm.prank(seller); house.claim();
        assertEq(usdc.balanceOf(address(house)), 0, "house empty after ERC20 lot");

        uint256 lot3 = _list(seller, 300_000, 1, 3600);
        _bid(carol, lot3, 300_000);
        vm.warp(_lotDeadline(lot3) + 1);
        house.settle(lot3);
        vm.prank(carol); house.confirmDelivery(lot3);
        // seller paid directly via _payOut; nothing in claimable
        assertEq(usdc.balanceOf(address(house)), 0, "house empty after OFFCHAIN lot");
    }

    function test_53_DisputeTimeout_OddAmount_ExactSplit() public {
        uint256 reserve = 1_000_001;
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
        uint256 sellerBefore = usdc.balanceOf(seller);
        uint256 aliceBefore  = usdc.balanceOf(alice);
        house.resolveDisputeTimeout(lotId);
        uint256 buyerShare = reserve / 2;
        uint256 sellerShare = reserve - buyerShare;
        assertEq(usdc.balanceOf(alice),  aliceBefore  + buyerShare,             "buyer gets floor(x/2)");
        assertEq(usdc.balanceOf(seller), sellerBefore + sellerShare + reserve,   "seller gets rest+bond");
        assertEq(buyerShare + sellerShare, reserve, "split sums to payment exactly");
    }

    // ── Audit regressions ──────────────────────────────────────────────────────

    function test_54_Escrow_StrangerCannotStrandPayment() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, lotId, 3_000_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        assertEq(house.claimable(seller), 0, "nothing to seller while escrow held");
        vm.warp(_lotSettledAt(lotId) + 7 days);
        vm.prank(carol);
        house.releaseEscrow(lotId);
        assertEq(usdc.balanceOf(seller), 3_000_000 + 1_000_000, "seller gets payment + bond (pushed)");
        vm.expectRevert("AuctionHouse: bond released");
        house.releaseEscrow(lotId);
        assertEq(usdc.balanceOf(address(house)), 0, "house empty after the only exit");
    }

    function test_55_DisputeTimeout_CountsFromDispute() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, lotId, 2_000_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        uint256 settledAt = _lotSettledAt(lotId);
        vm.warp(settledAt + 6 days);
        vm.prank(alice); house.dispute(lotId);
        vm.warp(settledAt + 14 days);
        vm.expectRevert("AuctionHouse: arbitration window open");
        house.resolveDisputeTimeout(lotId);
        vm.warp(settledAt + 6 days + 14 days);
        house.resolveDisputeTimeout(lotId);
        assertEq(usdc.balanceOf(alice), 1_000_000, "buyer half (pushed)");
        assertEq(usdc.balanceOf(seller), 1_000_000 + 1_000_000, "seller half + bond (pushed)");
    }

    function test_56_Escrow_ConfirmAndSellerAtFault() public {
        uint256 a = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, a, 2_000_000);
        vm.warp(_lotDeadline(a) + 1);
        house.settle(a);
        vm.prank(alice); house.confirmDelivery(a);
        assertEq(usdc.balanceOf(seller), 3_000_000, "confirm: payment + bond pushed to seller");

        uint256 b = _list(seller, 1_000_000, 100_000, 300);
        _bid(bob, b, 4_000_000);
        vm.warp(_lotDeadline(b) + 1);
        house.settle(b);
        vm.prank(bob); house.dispute(b);
        vm.expectRevert("AuctionHouse: escrow not held");
        house.releaseEscrow(b);
        house.resolveDispute(b, true);
        assertEq(usdc.balanceOf(bob), 4_000_000 + 1_000_000, "seller at fault: buyer gets payment + bond (pushed)");
    }

    function test_57_Vault_RejectsStrayERC721() public {
        MockERC721 nft = new MockERC721();
        uint256 id = nft.mint(alice);
        address vault = address(house.lotVault());
        vm.prank(alice);
        vm.expectRevert("LotVault: unexpected ERC721");
        nft.safeTransferFrom(alice, vault, id);
    }

    function test_58_Vault_RejectsUnsolicitedERC1155() public {
        MockERC1155 tok = new MockERC1155();
        tok.mint(alice, 7, 5);
        address vault = address(house.lotVault());
        vm.prank(alice);
        vm.expectRevert("LotVault: unexpected ERC1155");
        tok.safeTransferFrom(alice, vault, 7, 5, "");
    }

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
        vm.prank(alice); house.claimLotAsset(lotId, dave);
        assertEq(nft.ownerOf(id), dave, "delivered to the address the winner chose");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // v8 Tests
    // ══════════════════════════════════════════════════════════════════════════

    // ─── A1: Top-up bidding (direct bid reuses claimable) ─────────────────────

    /// Test 60: Full credit bid — amount fully covered by claimable, no transferFrom
    function test_60_Bid_FullCredit() public {
        uint256 lotId = _list(seller, 1_000_000, 500_000, 3600);
        _bid(alice, lotId, 1_000_000);  // alice is highest bidder
        _bid(bob,   lotId, 1_500_000);  // alice outbid: claimable[alice] = 1_000_000
        assertEq(house.claimable(alice), 1_000_000, "alice has claimable");

        // alice raises with a full-credit bid (1_500_000 + 500_000 = 2_000_000)
        // She needs 2_000_000 but has 1_000_000 in claimable; needs 1_000_000 more from wallet
        // Wait — let's do a pure full-credit test: alice has 1_000_000 claimable and bids 1_000_000 exactly
        // But that's below increment from 1_500_000. Let's give alice 1_500_001 claimable total.
        // Re-do: Alice bids 1_500_000 so she gets 1_500_000 claimable from bob, then bids 2_000_000.
        // Here let's just do a simpler test:
        // Create fresh lot, give carol 500_000 claimable, carol bids 500_000 with full credit.
        uint256 lotId2 = _list(seller, 500_000, 1, 3600);
        // give carol 500_000 claimable by letting her get outbid
        _bid(carol, lotId2, 500_000);
        _bid(dave,  lotId2, 500_001);
        assertEq(house.claimable(carol), 500_000, "carol has 500_000 claimable");

        // carol bids exactly 500_001 + 1 = 500_002 on lotId2
        // But she only has 500_000 claimable — need to fund 2 from wallet
        // Instead check: carol bids 500_000 (at reserve on a brand-new lot)
        uint256 lotId3 = _list(seller, 500_000, 1, 3600);
        // carol's claimable is 500_000; she bids 500_000 — full credit, 0 from wallet
        uint256 carolUsdcBefore = usdc.balanceOf(carol);
        vm.prank(carol);
        house.bid(lotId3, 500_000);
        assertEq(house.claimable(carol), 0, "carol credit fully consumed");
        assertEq(usdc.balanceOf(carol), carolUsdcBefore, "carol wallet unchanged (full credit)");
        assertEq(_lotHighestBidder(lotId3), carol, "carol is highest bidder");
    }

    /// Test 61: Partial credit bid — claimable covers part, wallet covers rest
    function test_61_Bid_PartialCredit() public {
        uint256 lotId = _list(seller, 1_000_000, 500_000, 3600);
        _bid(alice, lotId, 1_000_000);
        _bid(bob,   lotId, 1_500_000); // alice claimable = 1_000_000

        // alice re-enters with 2_000_000; has 1_000_000 claimable, needs 1_000_000 more from wallet
        uint256 aliceUsdcBefore = usdc.balanceOf(alice);
        usdc.mint(alice, 1_000_000); // fund the top-up portion
        vm.startPrank(alice);
        usdc.approve(address(house), 1_000_000);
        house.bid(lotId, 2_000_000);
        vm.stopPrank();
        assertEq(house.claimable(alice), 0, "alice credit fully used");
        assertEq(usdc.balanceOf(alice), aliceUsdcBefore, "alice wallet: only top-up consumed");
        assertEq(_lotHighestBidder(lotId), alice, "alice is highest");
        assertEq(_lotHighestBid(lotId), 2_000_000, "highestBid = 2_000_000");
    }

    /// Test 62: No credit bid — claimable is 0, full amount from wallet
    function test_62_Bid_NoCredit() public {
        uint256 lotId = _list(seller, 1_000_000, 500_000, 3600);
        assertEq(house.claimable(carol), 0, "carol has no claimable");
        // _bid mints 1_000_000 for carol; since claimable=0, full amount pulled via transferFrom.
        // After bid: carol.balance = 0 (minted then consumed).
        _bid(carol, lotId, 1_000_000);
        assertEq(usdc.balanceOf(carol), 0, "full amount consumed from wallet (no credit to reuse)");
        assertEq(_lotHighestBidder(lotId), carol, "carol is highest bidder");
    }

    /// Test 63: Leader raises own bid — credits back previous, then reuses in same bid
    function test_63_Bid_LeaderRaisesOwnBid() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 3600);
        _bid(alice, lotId, 1_000_000); // alice leads
        _bid(bob,   lotId, 1_100_000); // alice outbid; alice.claimable = 1_000_000
        // alice raises to 1_200_000 (= 1_100_000 + 100_000).
        // _bidCore credits bob (1_100_000 -> bob.claimable), then alice deducts credit from
        // her claimable (1_000_000), then pulls topUp (200_000) from wallet.
        usdc.mint(alice, 200_000);
        vm.startPrank(alice);
        usdc.approve(address(house), 200_000);
        house.bid(lotId, 1_200_000);
        vm.stopPrank();
        assertEq(_lotHighestBidder(lotId), alice, "alice leads again");
        assertEq(_lotHighestBid(lotId), 1_200_000, "highestBid = 1_200_000");
        assertEq(house.claimable(alice), 0, "alice credit consumed");
        assertEq(house.claimable(bob), 1_100_000, "bob refunded");
    }

    // ─── A1: Gasless top-up bid ────────────────────────────────────────────────

    /// Test 64: Gasless bid with topUp < amount — uses credit for the diff
    function test_64_GaslessBid_TopUp_PartialCredit() public {
        uint256 bidderPrivKey = 0xC0FFEE1;
        address bidder = vm.addr(bidderPrivKey);
        address relayer = makeAddr("relayer64");
        uint256 lotId = _list(seller, 1_000_000, 100_000, 3600);

        // give bidder 500_000 claimable by having them bid then get outbid
        _bid(bidder, lotId, 1_000_000);
        _bid(alice,  lotId, 1_100_000);
        assertEq(house.claimable(bidder), 1_000_000, "bidder has 1_000_000 credit");

        // gasless bid: amount=1_200_000, topUp=200_000, credit=1_000_000
        uint256 amount = 1_200_000; uint256 topUp = 200_000;
        bytes32 salt = keccak256("salt-64"); uint256 vb = block.timestamp + 3600;
        bytes32 nonce = _computeNonce(lotId, amount, topUp, salt);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(bidderPrivKey, bidder, address(house), topUp, 0, vb, nonce);
        usdc.mint(bidder, topUp);
        vm.prank(relayer);
        house.bidWithAuthorization(lotId, amount, topUp, bidder, 0, vb, salt, v, r, s);
        assertEq(_lotHighestBidder(lotId), bidder, "bidder is highest");
        assertEq(_lotHighestBid(lotId), amount, "bid = 1_200_000");
        assertEq(house.claimable(bidder), 0, "credit consumed");
        assertEq(usdc.balanceOf(bidder), 0, "topUp consumed from wallet");
    }

    /// Test 65: Gasless with wrong topUp (nonce mismatch) reverts
    function test_65_GaslessBid_WrongTopUp_Reverts() public {
        uint256 bidderPrivKey = 0xC0FFEE2;
        address bidder = vm.addr(bidderPrivKey);
        address relayer = makeAddr("relayer65");
        uint256 lotId = _list(seller, 1_000_000, 100_000, 3600);
        _bid(bidder, lotId, 1_000_000);
        _bid(alice,  lotId, 1_100_000);
        uint256 amount = 1_200_000; uint256 signedTopUp = 200_000; uint256 tamperedTopUp = 300_000;
        bytes32 salt = keccak256("salt-65"); uint256 vb = block.timestamp + 3600;
        bytes32 nonce = _computeNonce(lotId, amount, signedTopUp, salt);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(bidderPrivKey, bidder, address(house), signedTopUp, 0, vb, nonce);
        usdc.mint(bidder, tamperedTopUp);
        vm.prank(relayer);
        vm.expectRevert("MockUSDC: invalid signature");
        house.bidWithAuthorization(lotId, amount, tamperedTopUp, bidder, 0, vb, salt, v, r, s);
    }

    /// Test 66: Gasless with insufficient credit reverts
    function test_66_GaslessBid_InsufficientCredit_Reverts() public {
        uint256 bidderPrivKey = 0xC0FFEE3;
        address bidder = vm.addr(bidderPrivKey);
        address relayer = makeAddr("relayer66");
        uint256 lotId = _list(seller, 1_000_000, 100_000, 3600);
        // bidder has no claimable
        assertEq(house.claimable(bidder), 0);
        uint256 amount = 1_000_000; uint256 topUp = 800_000; // credit needed = 200_000; bidder has 0
        bytes32 salt = keccak256("salt-66"); uint256 vb = block.timestamp + 3600;
        bytes32 nonce = _computeNonce(lotId, amount, topUp, salt);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(bidderPrivKey, bidder, address(house), topUp, 0, vb, nonce);
        usdc.mint(bidder, topUp);
        vm.prank(relayer);
        vm.expectRevert("AuctionHouse: insufficient credit");
        house.bidWithAuthorization(lotId, amount, topUp, bidder, 0, vb, salt, v, r, s);
    }

    /// Test 67: Gasless with topUp == 0 reverts (credit-only must use direct bid)
    function test_67_GaslessBid_ZeroTopUp_Reverts() public {
        uint256 bidderPrivKey = 0xC0FFEE4;
        address bidder = vm.addr(bidderPrivKey);
        address relayer = makeAddr("relayer67");
        uint256 lotId = _list(seller, 1_000_000, 100_000, 3600);
        _bid(bidder, lotId, 1_000_000); // give credit
        _bid(alice,  lotId, 1_100_000);
        uint256 amount = 1_100_001; uint256 topUp = 0;
        bytes32 salt = keccak256("salt-67"); uint256 vb = block.timestamp + 3600;
        // Can't sign 0-value receiveWithAuthorization; just check the guard
        vm.prank(relayer);
        vm.expectRevert("AuctionHouse: topUp must be nonzero");
        // Use dummy sig — contract should revert before checking sig
        house.bidWithAuthorization(lotId, amount, topUp, bidder, 0, vb, salt, 0, bytes32(0), bytes32(0));
    }

    // ─── A2: _payOut (push succeeds and fallback to claimable) ────────────────

    /// Test 68: _payOut push succeeds — recipient wallet balance increases, claimable stays 0
    function test_68_PayOut_Push_Success() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, lotId, 1_000_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        uint256 sellerBalBefore = usdc.balanceOf(seller);
        vm.prank(alice);
        house.confirmDelivery(lotId);
        // _payOut pushed payment + bond directly
        assertEq(usdc.balanceOf(seller), sellerBalBefore + 2_000_000, "seller received push");
        assertEq(house.claimable(seller), 0, "no fallback to claimable");
    }

    /// Test 69: _payOut fallback — blocklisted recipient falls back to claimable
    function test_69_PayOut_Blocklist_FallsBackToClaimable() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, lotId, 1_000_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        // Blocklist the seller so transfer() returns false
        usdc.blocklist(seller);
        vm.prank(alice);
        house.confirmDelivery(lotId);
        // push failed → seller's funds in claimable
        assertEq(house.claimable(seller), 2_000_000, "seller gets claimable fallback");
        assertEq(usdc.balanceOf(seller), 0, "seller wallet unchanged");
    }

    /// Test 70: _payOut fallback — transfer reverts (blocklistReverts mode) → goes to claimable
    function test_70_PayOut_Revert_FallsBackToClaimable() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 300);
        _bid(alice, lotId, 1_000_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        // Set revert-on-blocklist mode
        usdc.blocklist(seller);
        usdc.setBlocklistReverts(true);
        vm.prank(alice);
        house.confirmDelivery(lotId);
        assertEq(house.claimable(seller), 2_000_000, "seller gets claimable fallback (revert mode)");
    }

    // ─── A3: refundBuyer with reason ──────────────────────────────────────────

    /// Test 71: refundBuyer emits BuyerRefunded with reason
    function test_71_RefundBuyer_WithReason_EventEmitted() public {
        uint256 lotId = _list(seller, 500_000, 1, 3600);
        _bid(alice, lotId, 500_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        vm.expectEmit(true, true, false, true, address(house));
        emit AuctionHouse.BuyerRefunded(lotId, alice, 500_000, "item is out of stock");
        vm.prank(seller);
        house.refundBuyer(lotId, "item is out of stock");
    }

    /// Test 72: reason over 280 bytes reverts
    function test_72_RefundBuyer_LongReason_Reverts() public {
        uint256 lotId = _list(seller, 500_000, 1, 3600);
        _bid(alice, lotId, 500_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        // Build 281-byte string
        bytes memory tooLong = new bytes(281);
        for (uint256 i = 0; i < 281; i++) tooLong[i] = 'A';
        vm.prank(seller);
        vm.expectRevert("AuctionHouse: reason too long");
        house.refundBuyer(lotId, string(tooLong));
    }

    // ─── A4: Evidence ─────────────────────────────────────────────────────────

    /// Test 73: buyer and seller each submit evidence on a HELD lot
    function test_73_Evidence_BuyerAndSeller() public {
        uint256 lotId = _list(seller, 500_000, 1, 3600);
        _bid(alice, lotId, 500_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        assertEq(uint8(house.escrowState(lotId)), uint8(AuctionHouse.EscrowState.HELD));
        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(house));
        emit AuctionHouse.Evidence(lotId, alice, "tracking: 1Z999AA10123456784");
        house.submitEvidence(lotId, "tracking: 1Z999AA10123456784");
        vm.prank(seller);
        house.submitEvidence(lotId, "shipped on 2026-10-25");
        assertEq(house.evidenceCount(lotId, alice), 1, "alice: 1 submission");
        assertEq(house.evidenceCount(lotId, seller), 1, "seller: 1 submission");
    }

    /// Test 74: evidence on DISPUTED lot is accepted
    function test_74_Evidence_Disputed() public {
        uint256 lotId = _list(seller, 500_000, 1, 3600);
        _bid(alice, lotId, 500_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        vm.prank(alice); house.dispute(lotId);
        vm.prank(alice);
        house.submitEvidence(lotId, "https://screenshot.example.com/delivery.png");
        assertEq(house.evidenceCount(lotId, alice), 1);
    }

    /// Test 75: non-party cannot submit evidence
    function test_75_Evidence_NonParty_Reverts() public {
        uint256 lotId = _list(seller, 500_000, 1, 3600);
        _bid(alice, lotId, 500_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        vm.prank(bob);
        vm.expectRevert("AuctionHouse: not a party");
        house.submitEvidence(lotId, "hacking attempt");
    }

    /// Test 76: evidence not accepted on closed escrow
    function test_76_Evidence_ClosedEscrow_Reverts() public {
        uint256 lotId = _list(seller, 500_000, 1, 3600);
        _bid(alice, lotId, 500_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        vm.prank(alice); house.confirmDelivery(lotId); // closes escrow
        vm.prank(alice);
        vm.expectRevert("AuctionHouse: escrow not active");
        house.submitEvidence(lotId, "too late");
    }

    /// Test 77: evidence text too long reverts
    function test_77_Evidence_TooLong_Reverts() public {
        uint256 lotId = _list(seller, 500_000, 1, 3600);
        _bid(alice, lotId, 500_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        bytes memory tooLong = new bytes(1001);
        for (uint256 i = 0; i < 1001; i++) tooLong[i] = 'A';
        vm.prank(alice);
        vm.expectRevert("AuctionHouse: evidence too long");
        house.submitEvidence(lotId, string(tooLong));
    }

    /// Test 78: evidence count limit (10 per party) reverts on 11th
    function test_78_Evidence_CountLimit_Reverts() public {
        uint256 lotId = _list(seller, 500_000, 1, 3600);
        _bid(alice, lotId, 500_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        vm.prank(alice); house.dispute(lotId); // keep DISPUTED so we have 14 days
        vm.startPrank(alice);
        for (uint256 i = 0; i < 10; i++) {
            house.submitEvidence(lotId, "evidence");
        }
        vm.expectRevert("AuctionHouse: evidence limit reached");
        house.submitEvidence(lotId, "11th");
        vm.stopPrank();
    }

    // ─── Funds conservation: credit bids + pushed payouts ─────────────────────

    /// Test 79: house ends at 0 after credit bids and _payOut pushes
    function test_79_FundsConservation_CreditBidsAndPushedPayouts() public {
        uint256 lotId = _list(seller, 1_000_000, 100_000, 3600);
        // alice bids 1_000_000
        _bid(alice, lotId, 1_000_000);
        // bob bids 1_100_000
        _bid(bob, lotId, 1_100_000); // alice.claimable = 1_000_000
        // alice re-bids 1_200_000 using 1_000_000 credit + 200_000 from wallet
        usdc.mint(alice, 200_000);
        vm.startPrank(alice);
        usdc.approve(address(house), 200_000);
        house.bid(lotId, 1_200_000);
        vm.stopPrank();
        // alice is highest; bob.claimable = 1_100_000
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        // alice confirms delivery; seller + bond pushed directly
        vm.prank(alice); house.confirmDelivery(lotId);
        // bob claims his outbid refund
        vm.prank(bob); house.claim();
        assertEq(usdc.balanceOf(address(house)), 0, "house ends at 0");
    }

    /// Test 80: CreditUsed event emitted when credit is applied
    function test_80_CreditUsed_EventEmitted() public {
        uint256 lotId = _list(seller, 1_000_000, 500_000, 3600);
        _bid(alice, lotId, 1_000_000);
        _bid(bob,   lotId, 1_500_000); // alice.claimable = 1_000_000
        // alice raises to 2_000_000: credit=1_000_000, topUp=1_000_000
        usdc.mint(alice, 1_000_000);
        vm.startPrank(alice);
        usdc.approve(address(house), 1_000_000);
        vm.expectEmit(true, true, false, true, address(house));
        emit AuctionHouse.CreditUsed(lotId, alice, 1_000_000); // all of alice's claimable
        house.bid(lotId, 2_000_000);
        vm.stopPrank();
    }

    /// Test 81: PaidOut event emitted with pushed=true on success
    function test_81_PaidOut_EventEmitted_Pushed() public {
        uint256 lotId = _list(seller, 500_000, 1, 3600);
        _bid(alice, lotId, 500_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        vm.expectEmit(true, false, false, true, address(house));
        emit AuctionHouse.PaidOut(seller, 1_000_000, true);
        vm.prank(alice);
        house.confirmDelivery(lotId);
    }

    /// Test 82: PaidOut event emitted with pushed=false when blocklisted
    function test_82_PaidOut_EventEmitted_NotPushed() public {
        uint256 lotId = _list(seller, 500_000, 1, 3600);
        _bid(alice, lotId, 500_000);
        vm.warp(_lotDeadline(lotId) + 1);
        house.settle(lotId);
        usdc.blocklist(seller);
        vm.expectEmit(true, false, false, true, address(house));
        emit AuctionHouse.PaidOut(seller, 1_000_000, false);
        vm.prank(alice);
        house.confirmDelivery(lotId);
    }

    /// Audit regression: a leader raising their own bid gaslessly reuses the bid
    /// that _bidCore just returned to them (credit check runs after _bidCore).
    function test_83_GaslessLeaderRaisesOwnBid_ReusesReturnedBid() public {
        uint256 pk = 0xA11CE83;
        address leader = vm.addr(pk);
        uint256 lotId = _list(seller, 1_000_000, 100_000, 3600);
        _bid(leader, lotId, 1_000_000);                       // leader holds 1.00, no credit
        assertEq(house.claimable(leader), 0, "no credit before raising");
        uint256 amount = 1_300_000; uint256 topUp = 300_000; // reuse the returned 1.00 + top up 0.30
        bytes32 salt = keccak256("salt-83"); uint256 vb = block.timestamp + 3600;
        bytes32 nonce = _computeNonce(lotId, amount, topUp, salt);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(pk, leader, address(house), topUp, 0, vb, nonce);
        usdc.mint(leader, topUp);
        vm.prank(makeAddr("relayer83"));
        house.bidWithAuthorization(lotId, amount, topUp, leader, 0, vb, salt, v, r, s);
        assertEq(_lotHighestBid(lotId), amount, "raised to 1.30");
        assertEq(house.claimable(leader), 0, "returned 1.00 reused as credit");
        assertEq(usdc.balanceOf(leader), 0, "only the 0.30 top-up was pulled");
        assertEq(usdc.balanceOf(address(house)), 1_000_000 + 1_300_000, "house holds the 1.00 bond + the 1.30 current bid, nothing else");
    }
}
