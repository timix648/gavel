// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract MockERC721 is ERC721 {
    uint256 private _nextId;

    constructor() ERC721("Mock NFT", "MNFT") {}

    function mint(address to) external returns (uint256 id) {
        id = _nextId++;
        _mint(to, id);
    }
}
