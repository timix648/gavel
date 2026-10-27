// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Minimal ERC-20 mock with 6 decimals, mint, and a blocklist.
///      Default blocklist mode: transfer() TO the blocked address returns false (not revert),
///      simulating Circle USDC blocklist behaviour on Arc Testnet.
///      Revert mode (blocklistReverts=true): transfer() TO the blocked address REVERTS,
///      needed to test _payOut's catch branch (when usdc.transfer itself reverts).
contract MockUSDC {
    string  public name     = "Mock USDC";
    string  public symbol   = "mUSDC";
    uint8   public decimals = 6;

    mapping(address => uint256)                     public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool)                        public blocked;
    mapping(address => mapping(bytes32 => bool))    public authorizationState;

    /// @dev When true, transfer() to a blocked address reverts instead of returning false.
    bool public blocklistReverts;

    // Optional: callback hook for reentrancy test
    address public transferHook; // if set, called with (to, amount) on transfer

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function totalSupply() external view returns (uint256) { return 0; } // unused

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function blocklist(address account) external {
        blocked[account] = true;
    }

    /// @dev Enable revert-on-blocklist mode (for _payOut catch branch tests).
    function setBlocklistReverts(bool reverts) external {
        blocklistReverts = reverts;
    }

    function setTransferHook(address hook) external {
        transferHook = hook;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (blocked[to]) {
            if (blocklistReverts) {
                revert("MockUSDC: blocklisted");
            }
            return false;
        }
        require(balanceOf[msg.sender] >= amount, "MockUSDC: insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        // Call hook AFTER state update so the hook sees up-to-date balances.
        if (transferHook != address(0)) {
            ITransferHook(transferHook).onTransfer(to, amount);
        }
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (blocked[to]) return false;
        require(balanceOf[from] >= amount, "MockUSDC: insufficient balance");
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "MockUSDC: insufficient allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(msg.sender == to, "MockUSDC: caller must be to");
        require(block.timestamp > validAfter, "MockUSDC: not yet valid");
        require(block.timestamp < validBefore, "MockUSDC: expired");
        require(!authorizationState[from][nonce], "MockUSDC: nonce used");

        // Domain name is hardcoded (not read from storage) so it survives vm.etch,
        // which copies bytecode only and leaves storage slots zeroed.
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Mock USDC")),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"),
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        address recovered = ecrecover(digest, v, r, s);
        require(recovered == from, "MockUSDC: invalid signature");

        authorizationState[from][nonce] = true;

        require(balanceOf[from] >= value, "MockUSDC: insufficient balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

interface ITransferHook {
    function onTransfer(address to, uint256 amount) external;
}
