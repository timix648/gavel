// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title LotVault v7
/// @notice Custody vault for all lot assets: GavelLot NFTs (OFFCHAIN), ERC721, ERC1155, ERC20.
///         Only the AuctionHouse can release assets.
///         ERC1155 deposits are guarded by _expectingDeposit to prevent unsolicited receives.
contract LotVault is IERC721Receiver, IERC1155Receiver {
    address public immutable auctionHouse;

    /// @dev Set to true only during an active ERC1155 safeTransferFrom in list(),
    ///      to prevent unsolicited onERC1155Received calls (T13).
    bool public expectingDeposit;

    modifier onlyAuctionHouse() {
        require(msg.sender == auctionHouse, "LotVault: only auction house");
        _;
    }

    constructor(address _auctionHouse) {
        require(_auctionHouse != address(0), "LotVault: zero auction house");
        auctionHouse = _auctionHouse;
    }

    // ─── Deposit guard ───────────────────────────────────────────────────────────

    /// @notice Toggle the ERC1155 deposit guard. Only callable by AuctionHouse.
    function setExpectingDeposit(bool value) external onlyAuctionHouse {
        expectingDeposit = value;
    }

    // ─── Release functions ───────────────────────────────────────────────────────

    /// @notice Release a GavelLot ERC721 token (OFFCHAIN lots).
    function releaseGavelLot(address to, uint256 tokenId) external onlyAuctionHouse {
        require(to != address(0), "LotVault: zero recipient");
        // Plain transferFrom: an NFT-rejecting winner must not freeze settlement.
        IERC721(_gavelLot()).transferFrom(address(this), to, tokenId);
    }

    /// @notice Release an ERC721 asset lot.
    function releaseERC721(address asset, address to, uint256 tokenId) external onlyAuctionHouse {
        require(to != address(0), "LotVault: zero recipient");
        IERC721(asset).transferFrom(address(this), to, tokenId);
    }

    /// @notice Release an ERC1155 asset lot.
    function releaseERC1155(address asset, address to, uint256 id, uint256 amount) external onlyAuctionHouse {
        require(to != address(0), "LotVault: zero recipient");
        IERC1155(asset).safeTransferFrom(address(this), to, id, amount, "");
    }

    /// @notice Release an ERC20 asset lot.
    function releaseERC20(address asset, address to, uint256 amount) external onlyAuctionHouse {
        require(to != address(0), "LotVault: zero recipient");
        SafeERC20.safeTransfer(IERC20(asset), to, amount);
    }

    // ─── ERC721 receiver ─────────────────────────────────────────────────────────

    /// @dev Only Gavel's own lot NFTs arrive via safe transfer (minted at listing).
    ///      ERC721 asset lots use transferFrom, so anything else is a mistaken send.
    function onERC721Received(address, address, uint256, bytes calldata)
        external view returns (bytes4)
    {
        require(msg.sender == _gavelLot(), "LotVault: unexpected ERC721");
        return IERC721Receiver.onERC721Received.selector;
    }

    // ─── ERC1155 receiver ─────────────────────────────────────────────────────────

    function onERC1155Received(
        address, address, uint256, uint256, bytes calldata
    ) external returns (bytes4) {
        require(expectingDeposit, "LotVault: unexpected ERC1155");
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address, address, uint256[] calldata, uint256[] calldata, bytes calldata
    ) external pure returns (bytes4) {
        revert("LotVault: batch not supported");
    }

    // ─── ERC165 ──────────────────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(IERC721Receiver).interfaceId ||
            interfaceId == type(IERC1155Receiver).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }

    // ─── Internal ────────────────────────────────────────────────────────────────

    /// @dev Read the GavelLot address from the AuctionHouse.
    function _gavelLot() internal view returns (address) {
        // AuctionHouse exposes gavelLot() as a public immutable.
        // We call it to avoid storing a duplicate reference.
        (bool ok, bytes memory data) = auctionHouse.staticcall(abi.encodeWithSignature("gavelLot()"));
        require(ok && data.length >= 32, "LotVault: gavelLot lookup failed");
        return abi.decode(data, (address));
    }
}
