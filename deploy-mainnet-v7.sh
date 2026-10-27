#!/usr/bin/env bash
# Deploys Gavel v7 to Arc MAINNET (chain 5042) from YOUR wallet, then allowlists
# EURC (ERC-20) and ERC-8004 agent identities (ERC-721).
# arc-forge / arc-cast ask for your private key themselves (--interactive); it is never stored or printed.
# Run inside WSL:  bash deploy-mainnet-v7.sh
set -e
cd "$(dirname "$0")"
R=https://rpc.mainnet.arc.io
F=~/.local/bin/arc-forge; C=~/.local/bin/arc-cast
IDENTITY=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432    # ERC-8004 IdentityRegistry, mainnet (checked: ERC-721)
REPUTATION=0x8004BAa17C55a88189AE136b182e5fdA19dE9b63  # ERC-8004 ReputationRegistry, mainnet (checked)
EURC=0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1        # EURC, mainnet (checked: 6 decimals)

[ "$($C chain-id --rpc-url $R)" = "5042" ] || { echo "RPC is not Arc mainnet"; exit 1; }
OWNER=0xBa6A590E4215CDE9448cd01A0B86531476E4dA0F
echo "Owner wallet: $OWNER   balance: $($C balance "$OWNER" --rpc-url $R --ether) USDC"

W=$HOME/gavel-mainnet-v7; rm -rf "$W/contracts"; mkdir -p "$W"
cp -r onchain/contracts onchain/foundry.toml onchain/remappings.txt "$W/"; cd "$W"
rm -rf contracts/test-integration contracts/script contracts/out contracts/cache
[ -d lib/forge-std ] || git clone -q --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
[ -d node_modules/@openzeppelin/contracts ] || cp -r "$HOME/gavel-slither/node_modules" .

echo; echo "== Tests (all must pass before deploying) =="
$F test 2>&1 | tail -2
$F test 2>&1 | grep -q "0 failed" || { echo "TESTS FAILED - not deploying"; exit 1; }

echo; echo "== 1/4 AuctionHouse v7: paste your private key when asked =="
$F create contracts/AuctionHouse.sol:AuctionHouse --rpc-url $R --broadcast --interactive \
  --constructor-args "$OWNER" | tee ah.out
AH=$(grep "Deployed to" ah.out | awk '{print $3}')
AHTX=$(grep "Transaction hash" ah.out | awk '{print $3}')

echo; echo "== 2/4 ReputationWriter: paste your private key again =="
$F create contracts/ReputationWriter.sol:ReputationWriter --rpc-url $R --broadcast --interactive \
  --constructor-args "$OWNER" "$AH" $IDENTITY $REPUTATION | tee rw.out
RW=$(grep "Deployed to" rw.out | awk '{print $3}')

echo; echo "== 3/4 Allowlist EURC as ERC-20: paste your private key again =="
$C send "$AH" 'setAllowedAsset(address,uint8,bool)' $EURC 3 true --rpc-url $R --interactive | grep -E "status|transactionHash"

echo; echo "== 4/4 Allowlist ERC-8004 agent identities as ERC-721: paste your private key again =="
$C send "$AH" 'setAllowedAsset(address,uint8,bool)' $IDENTITY 1 true --rpc-url $R --interactive | grep -E "status|transactionHash"

echo; echo "===== SEND THIS BLOCK BACK TO CLAUDE ====="
echo "AuctionHouse     $AH"
echo "AH deploy tx     $AHTX"
echo "AH deploy block  $($C receipt "$AHTX" blockNumber --rpc-url $R)"
echo "GavelLot         $($C call "$AH" 'gavelLot()(address)' --rpc-url $R)"
echo "LotVault         $($C call "$AH" 'lotVault()(address)' --rpc-url $R)"
echo "ReputationWriter $RW"
echo "Owner            $($C call "$AH" 'owner()(address)' --rpc-url $R)"
echo "EURC allowed     $($C call "$AH" 'isAssetAllowed(address)(bool,uint8)' $EURC --rpc-url $R | tr '\n' ' ')"
echo "8004 allowed     $($C call "$AH" 'isAssetAllowed(address)(bool,uint8)' $IDENTITY --rpc-url $R | tr '\n' ' ')"
echo "=========================================="
