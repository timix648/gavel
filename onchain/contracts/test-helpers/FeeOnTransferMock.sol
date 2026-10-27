// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice ERC20 that silently deducts a 1-unit fee on every transferFrom.
contract FeeOnTransferMock is ERC20 {
    constructor() ERC20("FeeToken", "FEE") {}

    function mint(address to, uint256 amount) external { _mint(to, amount); }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        // Burn 1 unit as a "fee" so the receiver gets amount-1.
        _transfer(from, address(0xdead), 1);
        return super.transferFrom(from, to, amount - 1);
    }
}
