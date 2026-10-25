#!/usr/bin/env bash
# Deploys GAVEL to Arc MAINNET (chain 5042) from YOUR wallet.
# arc-forge asks for your private key itself (--interactive); it is never stored or printed.
# Run inside WSL:  bash deploy-mainnet.sh
set -e
cd "$(dirname "$0")"
R=https://rpc.mainnet.arc.io
F=~/.local/bin/arc-forge; C=~/.local/bin/arc-cast
IDENTITY=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432    # ERC-8004 IdentityRegistry, mainnet (checked)
REPUTATION=0x8004BAa17C55a88189AE136b182e5fdA19dE9b63  # ERC-8004 ReputationRegistry, mainnet (checked)

[ "$($C chain-id --rpc-url $R)" = "5042" ] || { echo "RPC is not Arc mainnet"; exit 1; }
read -rp "Your deployer wallet address (becomes contract owner): " OWNER
echo "Balance: $($C balance "$OWNER" --rpc-url $R --ether) USDC"

W=$HOME/gavel-mainnet; rm -rf "$W/contracts"; mkdir -p "$W"
cp -r onchain/contracts onchain/foundry.toml onchain/remappings.txt "$W/"; cd "$W"
[ -d lib/forge-std ] || git clone -q --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
[ -d node_modules/@openzeppelin/contracts ] || cp -r "$HOME/gavel-slither/node_modules" .

echo; echo "== Tests (must all pass before deploying) =="
$F test 2>&1 | tail -2

echo; echo "== 1/2 AuctionHouse: paste your private key when asked =="
$F create contracts/AuctionHouse.sol:AuctionHouse --rpc-url $R --broadcast --interactive \
  --constructor-args "$OWNER" | tee ah.out
AH=$(grep "Deployed to" ah.out | awk '{print $3}')
AHTX=$(grep "Transaction hash" ah.out | awk '{print $3}')

echo; echo "== 2/2 ReputationWriter: paste your private key again =="
$F create contracts/ReputationWriter.sol:ReputationWriter --rpc-url $R --broadcast --interactive \
  --constructor-args "$OWNER" "$AH" $IDENTITY $REPUTATION | tee rw.out
RW=$(grep "Deployed to" rw.out | awk '{print $3}')

echo; echo "===== SEND THIS BLOCK BACK TO CLAUDE ====="
echo "AuctionHouse     $AH"
echo "AH deploy tx     $AHTX"
echo "AH deploy block  $($C receipt "$AHTX" blockNumber --rpc-url $R)"
echo "GavelLot         $($C call "$AH" 'gavelLot()(address)' --rpc-url $R)"
echo "ReputationWriter $RW"
echo "Owner            $($C call "$AH" 'owner()(address)' --rpc-url $R)"
echo "=========================================="
