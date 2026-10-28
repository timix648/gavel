import json, subprocess, os, sys
C=os.path.expanduser('~/.local/bin/arc-cast'); M='https://rpc.mainnet.arc.io'
AH='0xA51A6ac3E1B6954614E25721b1EEf4c7F854dEa6'; U='0x3600000000000000000000000000000000000000'; START=28077831
import time
def cast(*a):
    for _ in range(6):
        o=subprocess.run([C,*a,'--rpc-url',M],capture_output=True,text=True).stdout.strip()
        if o: return o
        time.sleep(2)
    return o
def call(sig,*a): return cast('call',AH,sig,*[str(x) for x in a]).split()[0] if True else None
sigs={"Listed(uint256,address,uint256,uint256,uint256)":"Listed","Bid(uint256,address,uint256)":"Bid","CreditUsed(uint256,address,uint256)":"CreditUsed","RelayedBid(uint256,address,address,uint256)":"RelayedBid","Outbid(uint256,address,uint256)":"Outbid","Extended(uint256,uint256,uint256)":"Extended","Hammer(uint256,address,uint256)":"Hammer","Unsold(uint256,address)":"Unsold","Claimed(address,uint256)":"Claimed","Cancelled(uint256,address)":"Cancelled","BondHeld(uint256,uint256)":"BondHeld","BondReleased(uint256,address,uint256)":"BondReleased","Disputed(uint256,address)":"Disputed","DisputeResolved(uint256,bool)":"DisputeResolved","AssetClaimed(uint256,address,address)":"AssetClaimed","EscrowReleased(uint256,address,uint256)":"EscrowReleased","BuyerRefunded(uint256,address,uint256,string)":"BuyerRefunded","PaidOut(address,uint256,bool)":"PaidOut","Evidence(uint256,address,string)":"Evidence"}
topic={subprocess.run([C,'keccak',s],capture_output=True,text=True).stdout.strip():n for s,n in sigs.items()}
head=int(cast('block-number'))
logs=[]
b=START
while b<=head:
    e=min(b+9000,head)
    out=subprocess.run([C,'logs','--address',AH,'--from-block',str(b),'--to-block',str(e),'--json','--rpc-url',M],capture_output=True,text=True).stdout
    try: logs+=json.loads(out or '[]')
    except Exception as ex: print('LOGERR',b,out[:200]); 
    b=e+1
ev=[]
for l in logs:
    n=topic.get(l['topics'][0],'?'); t=l['topics'][1:]; d=l['data'][2:]
    words=[d[i:i+64] for i in range(0,len(d),64)]
    ev.append((int(l['blockNumber'],16),int(l['logIndex'],16),n,t,words,l['transactionHash']))
ev.sort()
from collections import Counter
print('events',len(ev),Counter(e[2] for e in ev))
# accounting
inflow=0; outflow=0
txs=set(e[5] for e in ev)
print('distinct txs',len(txs))
addr=lambda x:'0x'+x[-40:]
bidders=set(); vol=0; bids=0; relayed=0
for blk,li,n,t,w,tx in ev:
    if n=='Bid': bidders.add(addr(t[1])); vol+=int(w[0],16); bids+=1
    if n=='RelayedBid': relayed+=1
print(f'bids={bids} relayed={relayed} distinct_bidders={len(bidders)} bid_volume={vol/1e6:.2f}')
N=int(call('nextLotId()(uint256)'))
print('lots',N)
for i in range(N):
    raw=cast('call',AH,'lots(uint256)(address,uint256,uint256,uint256,uint256,uint256,uint256,address,uint256,uint256,bool,bool,bool,bool)',str(i)).split('\n')
    f=[x.split()[0] for x in raw]
    kind=call('lotKind(uint256)(uint8)',i); es=call('escrowState(uint256)(uint8)',i)
    print(f'lot {i}: kind={kind} seller={f[0][:8]} reserve={int(f[2])/1e6} bond={int(f[4])/1e6} high={int(f[6])/1e6} winner={f[7][:8]} settled={f[10]} cancelled={f[11]} bondRel={f[12]} disputed={f[13]} escrow={es}')
print('AH USDC balance', int(cast('call',U,'balanceOf(address)(uint256)',AH).split()[0])/1e6)
# expected liabilities: claimables of all participants + live/held amounts
parts=set()
for blk,li,n,t,w,tx in ev:
    for x in t[1:] if n not in('Listed','Bid','Outbid','Hammer','Disputed','Evidence','CreditUsed','RelayedBid','Unsold','Cancelled','AssetClaimed','BuyerRefunded','BondReleased') else t[1:]:
        pass
for blk,li,n,t,w,tx in ev:
    for x in t:
        if x.startswith('0x000000000000000000000000') and int(x,16)>2**64: parts.add(addr(x))
tot=0
for p in sorted(parts):
    c=int(call('claimable(address)(uint256)',p))
    if c: print('claimable',p,c/1e6); tot+=c
print('participants checked',len(parts),'sum claimables',tot/1e6)
pushed=[(addr(t[0])[:8],int(w[0],16)/1e6,bool(int(w[1],16))) for _,_,n,t,w,_ in ev if n=='PaidOut']
print('PaidOut (to,amount,pushed):',pushed)
fails=[e for e in ev if e[2]=='?']
print('unknown events',len(fails))

print("--- per-lot timeline ---")
import collections
per=collections.defaultdict(list)
for blk,li,n,t,w,tx in ev:
    if n in ('Claimed','PaidOut'): key='payouts'
    else: key=int(t[0],16) if t else -1
    v=[int(x,16)/1e6 if len(x)==64 and int(x,16)<2**64 else x for x in w]
    per[key].append(f"{n} {', '.join(addr(x)[:8] for x in t[1:])} {v if n not in ('Evidence','BuyerRefunded') else ''} {tx[:10]}")
for k in sorted(per, key=lambda x: (isinstance(x,str), x)):
    print(f"[{k}]"); [print("   ",x) for x in per[k]]
