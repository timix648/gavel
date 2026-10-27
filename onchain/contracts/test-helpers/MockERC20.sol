// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Plain ERC20 mock (6 decimals, no fee, no block list).
contract MockERC20 is ERC20 {
    uint8 private _dec;

    constructor(string memory name_, string memory sym_, uint8 dec_) ERC20(name_, sym_) {
        _dec = dec_;
    }

    function decimals() public view override returns (uint8) { return _dec; }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
