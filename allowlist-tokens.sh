#!/usr/bin/env bash
# Allowlists the 9 vetted ERC-20 tokens on Gavel v8 (Arc mainnet). Owner only.
# Each token passed a full list -> bid -> settle -> claim auction on a fork of mainnet,
# with exact amounts in and out (vet.sh).
# Asks for your private key ONCE. It is stored only in an encrypted temporary keystore
# with a random password, used for the 9 transactions, then deleted.
# Run inside WSL:  bash allowlist-tokens.sh
set -euo pipefail
cd "$(dirname "$0")"
R=https://rpc.mainnet.arc.io; C=~/.local/bin/arc-cast
AH=0xA51A6ac3E1B6954614E25721b1EEf4c7F854dEa6
OWNER=0xBa6A590E4215CDE9448cd01A0B86531476E4dA0F

[ "$($C chain-id --rpc-url $R)" = "5042" ] || { echo "RPC is not Arc mainnet"; exit 1; }
[ "$($C call $AH 'owner()(address)' --rpc-url $R)" = "$OWNER" ] || { echo "Unexpected owner"; exit 1; }

KS=$(mktemp -d); PW=$(head -c 32 /dev/urandom | base64)
trap 'rm -rf "$KS"' EXIT
echo "Paste the OWNER private key (0xBa6A...dA0F). Input is hidden:"
$C wallet import gavel-owner --interactive --keystore-dir "$KS" --unsafe-password "$PW" >/dev/null
ADDR=$($C wallet address --keystore "$KS/gavel-owner" --password "$PW")
[ "$ADDR" = "$OWNER" ] || { echo "That key is for $ADDR, not the owner $OWNER. Stopping."; exit 1; }
echo "Key matches the owner. Sending 9 allowlist transactions..."

while read -r SYM TOK; do
  [ -z "$SYM" ] && continue
  OUT=$($C send $AH 'setAllowedAsset(address,uint8,bool)' "$TOK" 3 true \
        --keystore "$KS/gavel-owner" --password "$PW" --rpc-url $R --json)
  HASH=$(echo "$OUT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])')
  OK=$($C call $AH 'isAssetAllowed(address)(bool,uint8)' "$TOK" --rpc-url $R | tr '\n' ' ')
  printf "%-8s %s  allowed: %s\n" "$SYM" "$HASH" "$OK"
done <<'LIST'
cirBTC 0x171A4217b86A807A64eB94757Db6849fb4bDbAA0
LINK 0x76a443768A5e3B8d1AED0105FC250877841Deb40
XAUM 0x178b01f61CBeA1D2a5581Fe1621Be607835EC349
VIRTUAL 0x8C4252c87081c88c6Ad57d6dD97E1cAFebF842B7
GBPA 0xbBe6aAB0Ed76e90AeA0d1cd978EC231c8AdCDF8b
MXNB 0xF197FFC28c23E0309B5559e7a166f2c6164C80aA
QCAD 0xd70C2FA4232e054B373eFAEa98E4138511c2a309
TRYB 0xFb0705023603dc86325b83D9ff6b0DA7921fEc17
WBRL 0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0
LIST
echo "Done. Temporary keystore deleted."
