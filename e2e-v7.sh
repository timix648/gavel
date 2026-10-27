set -e; set -a; . ./local-services/.env.testnet; set +a
C=~/.local/bin/arc-cast; R=https://rpc.testnet.arc.io; IR=0x8004A818BFB912233c491871b3d84c89A494BD9e
AH=0x71A4FA23a2B7Fd7b4a11032c44f1e30591b83A04; U=0x3600000000000000000000000000000000000000
VAULT=$($C call $AH 'lotVault()(address)' --rpc-url $R)
send(){ local key=$1; shift; local out; out=$($C send "$@" --private-key $key --rpc-url $R --gas-price 30gwei --json 2>&1); echo "$out" | python3 -c 'import sys,json
try:
 d=json.load(sys.stdin); print("    ",d["transactionHash"], "ok" if d["status"]=="0x1" else "FAILED")
except Exception: print("     ERROR")'; echo "$out" | grep -o 'AuctionHouse: [a-zA-Z0-9 -]*' | head -1; }
claimable(){ $C call $AH 'claimable(address)(uint256)' $1 --rpc-url $R | cut -d' ' -f1; }
echo "== ERC-721 lot: a real ERC-8004 agent identity =="
echo "1. owner allowlists the IdentityRegistry as ERC721"; send $HOUSE_PRIVATE_KEY $AH 'setAllowedAsset(address,uint8,bool)' $IR 1 true
echo "2. seller registers an agent identity"
RH=$($C send $IR 'register(string)' "ipfs://gavel-v7-e2e" --private-key $HOUSE_PRIVATE_KEY --rpc-url $R --gas-price 30gwei --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["transactionHash"])'); echo "    $RH"
ID=$($C receipt $RH --rpc-url $R --json | python3 -c '
import sys,json
T="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
for l in json.load(sys.stdin)["logs"]:
    t=l["topics"]
    if t[0]==T and len(t)==4: print(int(t[3],16)); break')
echo "   agentId=$ID owner=$($C call $IR 'ownerOf(uint256)(address)' $ID --rpc-url $R)"
echo "3. approve + list it (reserve 0.10, step 0.05, 75 s)"; send $HOUSE_PRIVATE_KEY $IR 'approve(address,uint256)' $AH $ID
LOT=$($C call $AH 'nextLotId()(uint256)' --rpc-url $R | cut -d' ' -f1)
send $HOUSE_PRIVATE_KEY $AH 'list(uint8,address,uint256,uint256,string,uint256,uint256,uint256)' 1 $IR $ID 0 "ipfs://agent" 100000 75 50000
echo "   lot=$LOT vault owns identity: $( [ "$($C call $IR 'ownerOf(uint256)(address)' $ID --rpc-url $R)" = "$VAULT" ] && echo yes || echo NO)"
echo "4. seller tries to bid on own lot (must revert)"; $C call $AH 'bid(uint256,uint256)' $LOT 100000 --from $HOUSE_ADDRESS --rpc-url $R 2>&1 | grep -o 'AuctionHouse: [a-z ]*' | head -1
echo "5. A bids 0.10"; send $BIDDER_A_PRIVATE_KEY $U 'approve(address,uint256)' $AH 5000000; send $BIDDER_A_PRIVATE_KEY $AH 'bid(uint256,uint256)' $LOT 100000
echo "6. B bids 0.25 (jumps past the step)"; send $BIDDER_B_PRIVATE_KEY $U 'approve(address,uint256)' $AH 5000000; send $BIDDER_B_PRIVATE_KEY $AH 'bid(uint256,uint256)' $LOT 250000
echo "   A claimable after outbid: $(claimable $BIDDER_A_ADDRESS)"
DL=$($C call $AH 'lots(uint256)(address,uint256,uint256,uint256,uint256,uint256,uint256,address,uint256,uint256,bool,bool,bool,bool)' $LOT --rpc-url $R | sed -n 6p | cut -d' ' -f1)
while [ $($C block --rpc-url $R -f timestamp) -lt $DL ]; do sleep 3; done
SB=$(claimable $HOUSE_ADDRESS)
echo "7. settle"; send $BIDDER_A_PRIVATE_KEY $AH 'settle(uint256)' $LOT
echo "   seller credited at settle: $(( $(claimable $HOUSE_ADDRESS) - SB )) (want 250000)"
echo "8. stranger (A) tries to claim the asset (must revert)"; $C call $AH 'claimLotAsset(uint256,address)' $LOT $BIDDER_A_ADDRESS --from $BIDDER_A_ADDRESS --rpc-url $R 2>&1 | grep -o 'AuctionHouse: [a-z ]*' | head -1
echo "9. winner B claims identity to a DIFFERENT address (A's wallet)"; send $BIDDER_B_PRIVATE_KEY $AH 'claimLotAsset(uint256,address)' $LOT $BIDDER_A_ADDRESS
echo "   identity now owned by A: $( [ "$($C call $IR 'ownerOf(uint256)(address)' $ID --rpc-url $R)" = "$BIDDER_A_ADDRESS" ] && echo yes || echo NO)"
echo "10. double claim (must revert)"; $C call $AH 'claimLotAsset(uint256,address)' $LOT $BIDDER_B_ADDRESS --from $BIDDER_B_ADDRESS --rpc-url $R 2>&1 | grep -o 'AuctionHouse: [a-z ]*' | head -1
echo "11. A and seller withdraw"; send $BIDDER_A_PRIVATE_KEY $AH 'claim()'; send $HOUSE_PRIVATE_KEY $AH 'claim()'
echo "   house USDC balance (want 0): $($C call $U 'balanceOf(address)(uint256)' $AH --rpc-url $R | cut -d' ' -f1)"
