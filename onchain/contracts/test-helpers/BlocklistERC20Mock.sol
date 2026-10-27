// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice ERC20 that can blocklist addresses (transfer TO a blocklisted address reverts).
contract BlocklistERC20Mock is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("BlockToken", "BLK") {}

    function mint(address to, uint256 amount) external { _mint(to, amount); }

    function blocklist(address addr) external { blocked[addr] = true; }
    function unblocklist(address addr) external { blocked[addr] = false; }

    function _update(address from, address to, uint256 amount) internal override {
        require(!blocked[to], "BlocklistERC20: recipient blocked");
        super._update(from, to, amount);
    }
}
