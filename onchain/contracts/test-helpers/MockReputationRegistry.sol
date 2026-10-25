// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Minimal mock of a ReputationRegistry for ReputationWriter tests.
///      Records the arguments of every giveFeedback call so tests can
///      inspect them.  Also supports a revertOnNext flag so the try/catch
///      path in ReputationWriter can be exercised.
contract MockReputationRegistry {
    uint256 public callCount;
    uint256 public lastAgentId;
    int128  public lastValue;

    /// @dev If true, the next giveFeedback call reverts (then auto-resets).
    bool public revertOnNext;

    function setRevertOnNext(bool v) external {
        revertOnNext = v;
    }

    function giveFeedback(
        uint256 agentId,
        int128  value,
        uint8   /*valueDecimals*/,
        string calldata /*tag1*/,
        string calldata /*tag2*/,
        string calldata /*endpoint*/,
        string calldata /*feedbackURI*/,
        bytes32 /*feedbackHash*/
    ) external {
        if (revertOnNext) {
            revertOnNext = false;
            revert("MockReputationRegistry: forced revert");
        }
        callCount++;
        lastAgentId = agentId;
        lastValue   = value;
    }
}
