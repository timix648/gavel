// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

contract GavelLot is ERC721URIStorage {
    address public immutable auctionHouse;
    uint256 public nextTokenId = 1;

    modifier onlyAuctionHouse() {
        require(msg.sender == auctionHouse, "GavelLot: only auction house");
        _;
    }

    constructor(address _auctionHouse) ERC721("GavelLot", "LOT") {
        require(_auctionHouse != address(0), "GavelLot: zero auction house");
        auctionHouse = _auctionHouse;
    }

    function mint(address to, string calldata uri) external onlyAuctionHouse returns (uint256) {
        uint256 tokenId = nextTokenId;
        nextTokenId = tokenId + 1;

        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);

        return tokenId;
    }
}
