// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Minimal mock of an IdentityRegistry for ReputationWriter tests.
///      Maintains a counter (nextId starting at 0).
///      ownerOf(id) returns whoever called register() to claim that id.
contract MockIdentityRegistry {
    uint256 public nextId;
    mapping(uint256 => address) private _owners;

    /// @notice Returns the owner of a given agentId.
    function ownerOf(uint256 id) external view returns (address) {
        return _owners[id];
    }

    /// @notice Mints a new agentId to msg.sender and returns the new id.
    function register() external returns (uint256 id) {
        id = nextId;
        _owners[id] = msg.sender;
        nextId = id + 1;
    }
}
