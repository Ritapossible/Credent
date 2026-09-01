// The reviewer's exact scenario, driven end to end, then recovered.
//
//   "on Bradbury a wallet can mark itself proven, then withdraw clears its owed
//    balance before an undeliverable transfer, with no restoration path."
//
// Everything up to "no restoration path" is reproduced deliberately. Then
// `reclaim` is called and the entitlement comes back.
import { createAccount, createClient } from '/opt/node22/lib/node_modules/genlayer/node_modules/genlayer-js/dist/index.js'
import { testnetBradbury } from '/opt/node22/lib/node_modules/genlayer/node_modules/genlayer-js/dist/chains/index.js'
import { CalldataAddress } from '/opt/node22/lib/node_modules/genlayer/node_modules/genlayer-js/dist/types/index.js'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
const RPC = 'https://rpc-bradbury.genlayer.com'
const ORACLE = process.argv[2] ?? JSON.parse(
  readFileSync(new URL('../../deployments.json', import.meta.url), 'utf8'),
)['testnet-bradbury'].address
function gasProxy(){
  const srv=createServer((q,s)=>{let b="";q.on("data",c=>b+=c);q.on("end",async()=>{let p=null;try{p=JSON.parse(b)}catch{}
   const send=x=>{s.writeHead(200,{"content-type":"application/json"});s.end(JSON.stringify(x))};
   try{const u=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},body:b,signal:AbortSignal.timeout(60000)});const d=await u.json();
    if(p?.method==="eth_estimateGas"){let w=50000000n;if(typeof d.result==="string"){const g=BigInt(d.result)*5n;w=g>w?g:w;}if(w>60000000n)w=60000000n;
     return send({jsonrpc:"2.0",id:p.id,result:"0x"+w.toString(16)});}return send(d);}catch(e){return send({jsonrpc:"2.0",id:p?.id??null,error:{code:-32603,message:String(e)}})}})});
  return new Promise(r=>srv.listen(0,"127.0.0.1",()=>r({url:"http://127.0.0.1:"+srv.address().port,stop:()=>srv.close()})));
}
const proxy = await gasProxy()
const KD = process.env.CREDENT_KEYDIR
const clientAcct = createAccount(readFileSync(`${KD}/client.key`,'utf8').trim())
const provAcct   = createAccount(readFileSync(`${KD}/provider.key`,'utf8').trim())
const client = createClient({ chain: testnetBradbury, account: clientAcct, endpoint: proxy.url })
const prov   = createClient({ chain: testnetBradbury, account: provAcct,   endpoint: proxy.url })
const sleep = ms => new Promise(r=>setTimeout(r,ms))
const GEN = 10n**18n
const gen = v => (Number(v)/1e18).toFixed(6)
const view = (fn,args=[]) => client.readContract({ address: ORACLE, functionName: fn, args })
const big = v => BigInt(v)
const addr = hex => { const b=new Uint8Array(20); for(let i=0;i<20;i++) b[i]=parseInt(hex.slice(2+i*2,4+i*2),16); return new CalldataAddress(b) }
async function submit(fn, attempts=25){ let w=2000
  for(let i=1;;i++){ try { return await fn() } catch(e){ const t=String(e.message??e)
    if(!/(-32005|node is at capacity|gas rate limit)/.test(t)||i>=attempts) throw e
    await sleep(Math.max(Number(/retryAfterMs"?\s*:\s*(\d+)/.exec(t)?.[1]??0)+250,w)); w=Math.min(w*2,15000) } } }
async function send(c, fn, args, value=0n, label=fn){
  const h = await submit(()=>c.writeContract({address:ORACLE,functionName:fn,args,value}))
  await c.waitForTransactionReceipt({hash:h,status:'ACCEPTED',interval:5000,retries:200})
  console.log(`    ${label}`); console.log(`      https://explorer-bradbury.genlayer.com/tx/${h}`)
  return h
}
const settle = async (read, ok, ms=10*60*1000) => { const d=Date.now()+ms; let v=await read()
  while(!ok(v) && Date.now()<d){ await sleep(10000); v=await read() } return v }
let failures=0
const check=(ok,what)=>{console.log(`  ${ok?'ok  ':'FAIL'} ${what}`);if(!ok)failures++;return ok}

const W = provAcct.address
console.log(`oracle       ${ORACLE}`)
console.log(`wallet       ${W}   (an ordinary account, no code)\n`)

// Give the wallet an entitlement by overpaying collateral as provider.
const id = `recover-${Date.now()}`
const stake = GEN / 20n, overpay = GEN / 50n
await send(client,'open_engagement',[id,addr(W),'A small engagement, to produce a wallet entitlement.',stake],0n,'open_engagement')
const required = big((await view('collateral_quote',[addr(W),stake])).required)
await send(prov,'accept_engagement',[id],required+overpay,'accept_engagement (overpaying to create the entitlement)')
const owed0 = await settle(async()=>big(await view('owed_to',[W.toLowerCase()])), v=>v>=overpay)
check(owed0===overpay, `the wallet is owed ${gen(overpay)}`)

console.log(`\n  reproducing the reported failure`)
await send(prov,'prove_recipient',[],0n,'prove_recipient')
await send(prov,'confirm_recipient',[],0n,'confirm_recipient — the wallet answers its own probe')
const proven = await settle(async()=>((await view('is_proven',[W.toLowerCase()]))?1n:0n), v=>v===1n)
check(proven===1n,'the wallet marked itself proven (the reported bypass)')

const wBefore = await (async()=>{const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getBalance',params:[W,'latest']})});return BigInt((await r.json()).result)})()
await send(prov,'withdraw',[],0n,'withdraw — emits a transfer that cannot be delivered to a wallet')
await settle(async()=>big(await view('owed_to',[W.toLowerCase()])), v=>v===0n)
const inflight = await settle(async()=>big(await view('in_flight_to',[W.toLowerCase()])), v=>v>0n)
check(big(await view('owed_to',[W.toLowerCase()]))===0n,'owed is now zero — as the review describes')
check(inflight===overpay,`but the entitlement is parked in flight (${gen(inflight)}), not discarded`)

console.log(`\n  the restoration path the review asked for`)
await sleep(180000)   // let the undeliverable transfer settle either way
await send(prov,'reclaim',[],0n,'reclaim')
const restored = await settle(async()=>big(await view('owed_to',[W.toLowerCase()])), v=>v>0n, 8*60*1000)
const stillFlight = big(await view('in_flight_to',[W.toLowerCase()]))
const wAfter = await (async()=>{const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getBalance',params:[W,'latest']})});return BigInt((await r.json()).result)})()
console.log(`    wallet balance ${gen(wBefore)} -> ${gen(wAfter)} (gas only; a wallet is never credited)`)
check(restored===overpay,`the entitlement was RESTORED in full (${gen(restored)})`)
check(stillFlight===0n,'and the in-flight record was cleared, so it cannot be reclaimed twice')
const l = await view('liabilities')
console.log(`    liabilities  total_owed ${gen(big(l.total_owed))}  in_flight ${gen(big(l.total_in_flight))}  held ${gen(big(l.held))}`)
check(big(l.held)>=big(l.total_owed),'the contract still covers every entitlement')

console.log(`\n  and it cannot be replayed`)
// Judged on state, not on whether the call threw. A rejected transaction still
// reaches ACCEPTED -- consensus agreeing on a refusal is a success for the
// network -- and bradbury serves no receipt to read the reason from. If the
// replay had worked, `owed` would have doubled; that it did not is the proof.
const owedBeforeReplay = big(await view('owed_to',[W.toLowerCase()]))
try { await send(prov,'reclaim',[],0n,'reclaim again (expected to be refused)') } catch (e) { console.log('      threw') }
await sleep(30000)
const owedAfterReplay = big(await view('owed_to',[W.toLowerCase()]))
console.log(`    owed ${gen(owedBeforeReplay)} -> ${gen(owedAfterReplay)}`)
check(owedAfterReplay === owedBeforeReplay, 'a second reclaim credited nothing — the restore cannot be replayed')

proxy.stop()
console.log(failures===0 ? '\nrecovery ok — a failed transfer left the entitlement recoverable, and it was recovered'
                         : `\n${failures} check(s) FAILED`)
process.exit(failures===0?0:1)
