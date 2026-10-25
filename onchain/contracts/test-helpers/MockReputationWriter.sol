// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Stub IReputationWriter whose cleanSalesView reverts on demand.
///      Used by test_31 to verify that AuctionHouse.list() safely falls back
///      to the full bond when the reputation call throws.
contract MockReputationWriter {
    bool public revertOnCleanSales;
    uint256 public stubbedCleanSales;

    function setRevertOnCleanSales(bool v) external {
        revertOnCleanSales = v;
    }

    function setStubbedCleanSales(uint256 v) external {
        stubbedCleanSales = v;
    }

    function cleanSalesView(address /*seller*/) external view returns (uint256) {
        require(!revertOnCleanSales, "MockReputationWriter: forced revert");
        return stubbedCleanSales;
    }
}
