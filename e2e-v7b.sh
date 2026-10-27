set -a; . ./local-services/.env.testnet; set +a
C=~/.local/bin/arc-cast; R=https://rpc.testnet.arc.io; AH=0x71A4FA23a2B7Fd7b4a11032c44f1e30591b83A04; U=0x3600000000000000000000000000000000000000
send(){ local key=$1; shift; local out; out=$($C send "$@" --private-key $key --rpc-url $R --gas-price 30gwei --json 2>&1); echo "$out" | python3 -c 'import sys,json
try:
 d=json.load(sys.stdin); print("    ",d["transactionHash"], "ok" if d["status"]=="0x1" else "FAILED")
except Exception: print("     ERROR")'; echo "$out" | grep -o 'AuctionHouse: [a-zA-Z0-9 -]*' | head -1; }
cl(){ $C call $AH 'claimable(address)(uint256)' $1 --rpc-url $R | cut -d' ' -f1; }
es(){ $C call $AH 'escrowState(uint256)(uint8)' $1 --rpc-url $R; }
dl(){ $C call $AH 'lots(uint256)(address,uint256,uint256,uint256,uint256,uint256,uint256,address,uint256,uint256,bool,bool,bool,bool)' $1 --rpc-url $R | sed -n 6p | cut -d' ' -f1; }
waitend(){ local d=$(dl $1); while [ $($C block --rpc-url $R -f timestamp) -lt $d ]; do sleep 3; done; }
for scenario in confirm refund; do
 echo "== OFF-CHAIN lot, path: $scenario =="
 send $HOUSE_PRIVATE_KEY $U 'approve(address,uint256)' $AH 5000000
 L=$($C call $AH 'nextLotId()(uint256)' --rpc-url $R | cut -d' ' -f1)
 send $HOUSE_PRIVATE_KEY $AH 'list(uint8,address,uint256,uint256,string,uint256,uint256,uint256)' 0 0x0000000000000000000000000000000000000000 0 0 "ipfs://service" 100000 45 50000
 send $BIDDER_A_PRIVATE_KEY $AH 'bid(uint256,uint256)' $L 300000
 waitend $L; S0=$(cl $HOUSE_ADDRESS); A0=$(cl $BIDDER_A_ADDRESS)
 send $BIDDER_B_PRIVATE_KEY $AH 'settle(uint256)' $L
 echo "   after settle: escrowState=$(es $L) (1=HELD) seller credited=$(( $(cl $HOUSE_ADDRESS) - S0 )) (want 0)"
 if [ $scenario = confirm ]; then
  echo "   stranger tries releaseEscrow before window (must revert)"; send $BIDDER_B_PRIVATE_KEY $AH 'releaseEscrow(uint256)' $L
  send $BIDDER_A_PRIVATE_KEY $AH 'confirmDelivery(uint256)' $L
  echo "   after confirm: escrowState=$(es $L) (3=CLOSED) seller credited=$(( $(cl $HOUSE_ADDRESS) - S0 )) (want 400000 = 0.30 + 0.10 bond)"
 else
  send $HOUSE_PRIVATE_KEY $AH 'refundBuyer(uint256)' $L
  echo "   after refund: buyer credited=$(( $(cl $BIDDER_A_ADDRESS) - A0 )) (want 300000) seller credited=$(( $(cl $HOUSE_ADDRESS) - S0 )) (want 100000 bond)"
 fi
done
echo "== withdraw all =="
[ $(cl $HOUSE_ADDRESS) -gt 0 ] && send $HOUSE_PRIVATE_KEY $AH 'claim()'
[ $(cl $BIDDER_A_ADDRESS) -gt 0 ] && send $BIDDER_A_PRIVATE_KEY $AH 'claim()'
echo "   house USDC balance (want 0): $($C call $U 'balanceOf(address)(uint256)' $AH --rpc-url $R | cut -d' ' -f1)"
