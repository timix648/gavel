set -u
A=~/.local/bin/arc-anvil; C=~/.local/bin/arc-cast; R=http://127.0.0.1:8547
$A --fork-url https://rpc.mainnet.arc.io --port 8547 --silent >/tmp/anvil.log 2>&1 & AP=$!
for i in $(seq 1 60); do $C block-number --rpc-url $R >/dev/null 2>&1 && break; sleep 1; done
echo "fork at block $($C block-number --rpc-url $R)"
AH=0xA51A6ac3E1B6954614E25721b1EEf4c7F854dEa6; OWNER=0xBa6A590E4215CDE9448cd01A0B86531476E4dA0F; U=0x3600000000000000000000000000000000000000
BIDDER=0x00000000000000000000000000000000000B1D01; DEST=0x00000000000000000000000000000000000DE5D1
imp(){ $C rpc anvil_impersonateAccount $1 --rpc-url $R >/dev/null; $C rpc anvil_setBalance $1 0x56BC75E2D63100000 --rpc-url $R >/dev/null; }
tx(){ local from=$1; shift; $C send --unlocked --from $from "$@" --rpc-url $R --json 2>/dev/null | python3 -c 'import sys,json
try: print(json.load(sys.stdin)["status"])
except Exception: print("ERR")'; }
bal(){ $C call $1 'balanceOf(address)(uint256)' $2 --rpc-url $R | cut -d' ' -f1; }
imp $OWNER; imp $BIDDER
echo "bidder USDC (ERC-20 view): $(bal $U $BIDDER)"
VAULT=$($C call $AH 'lotVault()(address)' --rpc-url $R)
while read SYM TOK HOLDER DEC; do
  [ -z "$SYM" ] && continue
  imp $HOLDER
  AMT=$(python3 -c "print(10**$DEC//2)")   # half a token
  r1=$(tx $OWNER $AH 'setAllowedAsset(address,uint8,bool)' $TOK 3 true)
  r2=$(tx $HOLDER $TOK 'approve(address,uint256)' $AH $AMT)
  LOT=$($C call $AH 'nextLotId()(uint256)' --rpc-url $R | cut -d' ' -f1)
  VB=$(bal $TOK $VAULT)
  r3=$(tx $HOLDER $AH 'list(uint8,address,uint256,uint256,string,uint256,uint256,uint256)' 3 $TOK 0 $AMT "x" 1000000 60 100000)
  VA=$(bal $TOK $VAULT)
  r4=$(tx $BIDDER $U 'approve(address,uint256)' $AH 2000000)
  r5=$(tx $BIDDER $AH 'bid(uint256,uint256)' $LOT 1000000)
  $C rpc evm_increaseTime 120 --rpc-url $R >/dev/null; $C rpc evm_mine --rpc-url $R >/dev/null
  r6=$(tx $BIDDER $AH 'settle(uint256)' $LOT)
  DB=$(bal $TOK $DEST)
  r7=$(tx $BIDDER $AH 'claimLotAsset(uint256,address)' $LOT $DEST)
  DA=$(bal $TOK $DEST); VE=$(bal $TOK $VAULT)
  IN=$(python3 -c "print(int('$VA')-int('$VB'))"); OUT=$(python3 -c "print(int('$DA')-int('$DB'))")
  OK=$([ "$r3" = 0x1 ] && [ "$r7" = 0x1 ] && [ "$IN" = "$AMT" ] && [ "$OUT" = "$AMT" ] && echo PASS || echo FAIL)
  printf "%-8s %s  list=%s bid=%s settle=%s claim=%s  vault_in=%s winner_got=%s (want %s)\n" "$SYM" "$OK" "$r3" "$r5" "$r6" "$r7" "$IN" "$OUT" "$AMT"
done <<'LIST'
EURC 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1 0x7B79FD67C7bBc938340F0769bF8a64Ab9B43E1D5 6
cirBTC 0x171A4217b86A807A64eB94757Db6849fb4bDbAA0 0x15abb66bA754F05cBC0165A64A11cDed1543dE48 8
LINK 0x76a443768A5e3B8d1AED0105FC250877841Deb40 0x18Ec5566Ad26E2aC609822395d6D9e98a39C90ef 18
XAUM 0x178b01f61CBeA1D2a5581Fe1621Be607835EC349 0xEF130Aa6C471C46bCe96eaF77f561ECE333B1770 18
VIRTUAL 0x8C4252c87081c88c6Ad57d6dD97E1cAFebF842B7 0x26c2448c0038874F68cc0d388D96F8D218aF3BDF 18
GBPA 0xbBe6aAB0Ed76e90AeA0d1cd978EC231c8AdCDF8b 0x811b9026A7638538B29766Dd61730950389990C8 6
MXNB 0xF197FFC28c23E0309B5559e7a166f2c6164C80aA 0x95324AB22a20C4396be548C92e8F27BbB2FDb2A7 6
QCAD 0xd70C2FA4232e054B373eFAEa98E4138511c2a309 0xcb42Bab5B0B27D2bCE4519152f46b42F430e0a4B 6
TRYB 0xFb0705023603dc86325b83D9ff6b0DA7921fEc17 0x8f58955bB4dfF80f956B4683d29b62C984D4657F 18
WBRL 0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0 0x7e3022272b9d6386Eb36569c8E5b7a2457D48d5C 18
LIST
kill $AP
