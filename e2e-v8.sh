set -a; . ./local-services/.env.testnet; set +a
C=~/.local/bin/arc-cast; F=~/.local/bin/arc-forge; R=https://rpc.testnet.arc.io; U=0x3600000000000000000000000000000000000000
cd ~/gavel-test; AH=$($F create contracts/AuctionHouse.sol:AuctionHouse --rpc-url $R --private-key $HOUSE_PRIVATE_KEY --broadcast --constructor-args $HOUSE_ADDRESS 2>&1 | grep "Deployed to" | awk '{print $3}'); cd - >/dev/null
echo "v8 (fixed) testnet AuctionHouse: $AH"
send(){ local key=$1; shift; local out; out=$($C send "$@" --private-key $key --rpc-url $R --gas-price 30gwei --json 2>&1); echo "$out" | python3 -c 'import sys,json
try:
 d=json.load(sys.stdin); print("    ",d["transactionHash"], "ok" if d["status"]=="0x1" else "FAILED")
except Exception: print("     ERROR")'; echo "$out" | grep -o 'AuctionHouse: [a-zA-Z0-9 -]*' | head -1; }
cl(){ $C call $AH 'claimable(address)(uint256)' $1 --rpc-url $R | cut -d' ' -f1; }
bal(){ $C call $U 'balanceOf(address)(uint256)' $1 --rpc-url $R | cut -d' ' -f1; }
dl(){ $C call $AH 'lots(uint256)(address,uint256,uint256,uint256,uint256,uint256,uint256,address,uint256,uint256,bool,bool,bool,bool)' $1 --rpc-url $R | sed -n 6p | cut -d' ' -f1; }
waitend(){ local d=$(dl $1); while [ $($C block --rpc-url $R -f timestamp) -lt $d ]; do sleep 3; done; }
for k in $HOUSE_PRIVATE_KEY $BIDDER_A_PRIVATE_KEY $BIDDER_B_PRIVATE_KEY; do send $k $U 'approve(address,uint256)' $AH 10000000 >/dev/null; done
echo "== Lot 0 (off-chain): top-up bidding =="
send $HOUSE_PRIVATE_KEY $AH 'list(uint8,address,uint256,uint256,string,uint256,uint256,uint256)' 0 0x0000000000000000000000000000000000000000 0 0 "data:application/json;base64,eyJ0aXRsZSI6InRlc3QifQ==" 100000 60 50000
send $BIDDER_A_PRIVATE_KEY $AH 'bid(uint256,uint256)' 0 200000
send $BIDDER_B_PRIVATE_KEY $AH 'bid(uint256,uint256)' 0 300000
echo "   A outbid: claimable=$(cl $BIDDER_A_ADDRESS) (want 200000)"
A0=$(bal $BIDDER_A_ADDRESS)
echo "   A re-bids 0.40 with 0.20 credit"; send $BIDDER_A_PRIVATE_KEY $AH 'bid(uint256,uint256)' 0 400000
echo "   A wallet paid: $(( A0 - $(bal $BIDDER_A_ADDRESS) )) (want 200000, i.e. only the top-up)   A claimable now: $(cl $BIDDER_A_ADDRESS) (want 0)"
waitend 0; send $BIDDER_B_PRIVATE_KEY $AH 'settle(uint256)' 0
echo "   evidence: buyer A posts a note"; send $BIDDER_A_PRIVATE_KEY $AH 'submitEvidence(uint256,string)' 0 "Waiting on delivery; seller contacted on Telegram 27 Oct"
echo "   evidence from a stranger (must revert)"; send $BIDDER_B_PRIVATE_KEY $AH 'submitEvidence(uint256,string)' 0 "spam"
A1=$(bal $BIDDER_A_ADDRESS); S1=$(bal $HOUSE_ADDRESS)
echo "   seller refunds with a reason"; send $HOUSE_PRIVATE_KEY $AH 'refundBuyer(uint256,string)' 0 "Item out of stock, sorry"
echo "   buyer wallet received directly: $(( $(bal $BIDDER_A_ADDRESS) - A1 )) (want 400000), buyer claimable: $(cl $BIDDER_A_ADDRESS) (want 0)"
echo "   seller bond back to wallet: $(( $(bal $HOUSE_ADDRESS) - S1 )) (minus gas; want ~100000)"
echo "== withdraw remaining credit (B's outbid 0.30) =="
[ $(cl $BIDDER_B_ADDRESS) -gt 0 ] && send $BIDDER_B_PRIVATE_KEY $AH 'claim()'
echo "   house USDC (want 0): $(bal $AH)"
