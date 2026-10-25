// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

contract LotVault is IERC721Receiver {
    address public immutable gavelLot;
    address public immutable auctionHouse;

    modifier onlyAuctionHouse() {
        require(msg.sender == auctionHouse, "LotVault: only auction house");
        _;
    }

    constructor(address _gavelLot, address _auctionHouse) {
        require(_gavelLot != address(0), "LotVault: zero gavel lot");
        require(_auctionHouse != address(0), "LotVault: zero auction house");
        gavelLot = _gavelLot;
        auctionHouse = _auctionHouse;
    }

    function release(address to, uint256 tokenId) external onlyAuctionHouse {
        require(to != address(0), "LotVault: zero recipient");
        // Plain transferFrom: a winner contract that rejects ERC-721 must not
        // be able to make settle() revert forever and lock the seller's funds.
        IERC721(gavelLot).transferFrom(address(this), to, tokenId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
