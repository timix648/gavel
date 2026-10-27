// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Minimal interface to read a lot's settled/bondReleased/disputed/seller/highestBidder
///         from AuctionHouse v7. The full Lot struct is returned by lots(id).
interface IAuctionHouse {
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
        bool settled;
        bool cancelled;
        bool bondReleased;
        bool disputed;
    }

    function lots(uint256 lotId) external view returns (Lot memory);
}

interface IIdentityRegistry {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}

contract ReputationWriter is Ownable {
    IAuctionHouse public immutable auctionHouse;
    IIdentityRegistry public immutable identityRegistry;
    IReputationRegistry public immutable reputationRegistry;

    mapping(address => uint256) public sellerAgentId;
    mapping(address => bool) public sellerRegistered;
    mapping(uint256 => bool) public lotRecorded;
    mapping(address => uint256) public cleanSales;

    event SaleRecorded(uint256 indexed lotId, address indexed seller, uint256 indexed agentId, bool positive);
    event SellerRegistered(address indexed seller, uint256 indexed agentId);

    constructor(
        address initialOwner,
        address auctionHouse_,
        address identityRegistry_,
        address reputationRegistry_
    ) Ownable(msg.sender) {
        require(auctionHouse_ != address(0), "ReputationWriter: zero AH");
        require(identityRegistry_ != address(0), "ReputationWriter: zero IR");
        require(reputationRegistry_ != address(0), "ReputationWriter: zero RR");
        auctionHouse = IAuctionHouse(auctionHouse_);
        identityRegistry = IIdentityRegistry(identityRegistry_);
        reputationRegistry = IReputationRegistry(reputationRegistry_);
        transferOwnership(initialOwner);
    }

    function linkSeller(uint256 agentId) external {
        require(!sellerRegistered[msg.sender], "ReputationWriter: already registered");
        require(identityRegistry.ownerOf(agentId) == msg.sender, "ReputationWriter: not agentId owner");
        sellerAgentId[msg.sender] = agentId;
        sellerRegistered[msg.sender] = true;
        emit SellerRegistered(msg.sender, agentId);
    }

    function recordSale(uint256 lotId) external {
        require(!lotRecorded[lotId], "ReputationWriter: already recorded");

        IAuctionHouse.Lot memory lot = auctionHouse.lots(lotId);

        require(lot.seller != address(0), "ReputationWriter: invalid lot");
        require(lot.settled, "ReputationWriter: not settled");

        if (lot.highestBidder == address(0)) {
            lotRecorded[lotId] = true;
            return;
        }

        require(lot.bondReleased, "ReputationWriter: bond not released");

        bool positive = !lot.disputed;

        if (lot.highestBidder == lot.seller) {
            lotRecorded[lotId] = true;
            emit SaleRecorded(lotId, lot.seller, 0, false);
            return;
        }

        lotRecorded[lotId] = true;

        if (positive) {
            cleanSales[lot.seller]++;
        }

        if (sellerRegistered[lot.seller]) {
            uint256 agentId = sellerAgentId[lot.seller];
            int128 score = positive ? int128(1) : int128(-1);
            string memory tag1 = positive ? "gavel.sale.positive" : "gavel.sale.negative";
            string memory feedbackURI = "";
            bytes32 feedbackHash = keccak256(abi.encode(lotId, lot.seller, positive));

            try reputationRegistry.giveFeedback(
                agentId, score, 0, tag1, "gavel", "", feedbackURI, feedbackHash
            ) {} catch {}
        }

        emit SaleRecorded(lotId, lot.seller, sellerRegistered[lot.seller] ? sellerAgentId[lot.seller] : 0, positive);
    }

    function cleanSalesView(address seller) external view returns (uint256) {
        return cleanSales[seller];
    }
}
