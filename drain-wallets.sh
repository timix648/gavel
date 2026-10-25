#!/usr/bin/env bash
# Sends the full Arc MAINNET USDC balance of each project wallet (minus gas) to your main wallet.
# Usage (WSL, project folder):  bash drain-wallets.sh 0xYourMainWallet
set -e
cd "$(dirname "$0")"
DEST="$1"; [[ "$DEST" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "Usage: bash drain-wallets.sh 0xYourMainWallet"; exit 1; }
R=https://rpc.mainnet.arc.io; C=~/.local/bin/arc-cast
set -a; . ./local-services/.env.testnet; set +a
GAS=21000
PRICE=$(( $($C gas-price --rpc-url $R) * 2 ))                       # 2x current price, safely above the 20 gwei floor
for n in RELAYER HOUSE BIDDER_A BIDDER_B; do
  ADDR=$(eval echo \$${n}_ADDRESS); KEY=$(eval echo \$${n}_PRIVATE_KEY)
  BAL=$($C balance "$ADDR" --rpc-url $R)                            # native USDC, 18 decimals
  SEND=$(python3 -c "print(max(0, $BAL - $GAS * $PRICE))")
  [ "$SEND" = "0" ] && { echo "$n $ADDR: nothing to send"; continue; }
  echo "$n $ADDR -> $DEST : $($C from-wei "$SEND") USDC"
  read -rp "Send? [y/N] " ok; [ "$ok" = "y" ] || continue
  $C send "$DEST" --value "$SEND" --gas-limit $GAS --gas-price $PRICE --private-key "$KEY" --rpc-url $R | grep -E "transactionHash|status"
done
