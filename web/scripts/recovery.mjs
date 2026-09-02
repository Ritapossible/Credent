// The reviewer's exact scenario, driven end to end against the live contract.
//
//   "on Bradbury a wallet can mark itself proven, then withdraw clears its owed
//    balance before an undeliverable transfer, with no restoration path."
//
// Three clauses, and this script takes them in order on bradbury -- the network
// the review named, and the one where the old origin check could not fire.
//
//   1. "a wallet can mark itself proven"  -- it cannot. `prove_recipient` and
//      `confirm_recipient` are both refused for a wallet, so no probe is ever
//      raised and there is nothing to answer. `withdraw` is refused too, and
//      the wallet's entitlement is left exactly where it was.
//   2. "withdraw clears its owed balance" -- it parks it. Shown on a real
//      recipient contract: `owed` goes to zero and the same amount appears
//      under `in_flight_to`, readable throughout.
//   3. "with no restoration path"         -- `reclaim` is the path. It settles
//      an in-flight withdrawal against the recipient's own balance, closing it
//      when the value arrived and crediting the entitlement back when it did
//      not, and it cannot be run twice.
//
// Every step prints its transaction, so each claim above can be opened in the
// explorer rather than taken on trust.
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
async function sendTo(c, address, fn, args, label=fn){
  const h = await submit(()=>c.writeContract({address,functionName:fn,args,value:0n}))
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

console.log(`\n  clause 1: "a wallet can mark itself proven"`)
// Judged on state rather than on whether the call threw. The refusal here is a
// view call into an address with no code: the transaction does not complete, and
// bradbury serves no reason string for it either way. What settles the question
// is that `is_proven` never turns true and the entitlement never moves.
const provenBefore = (await view('is_proven',[W.toLowerCase()])) ? 1n : 0n
await send(prov,'prove_recipient',[],0n,'prove_recipient — from the wallet, expected to be refused').catch(()=>console.log('      threw'))
await sleep(20000)
check(((await view('is_proven',[W.toLowerCase()]))?1n:0n)===0n,'the wallet did not become proven')
check(big(await view('owed_to',[W.toLowerCase()]))===owed0,'and its entitlement was not touched')
await send(prov,'confirm_recipient',[],0n,'confirm_recipient — the wallet answering a probe it never got').catch(()=>console.log('      threw'))
await sleep(20000)
const provenAfter = (await view('is_proven',[W.toLowerCase()])) ? 1n : 0n
check(provenAfter===provenBefore && provenAfter===0n,'still unproven — the reported bypass is closed')
await send(prov,'withdraw',[],0n,'withdraw — from the wallet, expected to be refused').catch(()=>console.log('      threw'))
await sleep(20000)
check(big(await view('owed_to',[W.toLowerCase()]))===owed0,'withdraw did not clear the wallet\'s owed balance')
check(big(await view('in_flight_to',[W.toLowerCase()]))===0n,'and nothing was put in flight')

console.log(`\n  clauses 2 and 3, on a recipient that can actually be paid`)
// A Credent recipient contract: it implements `credent_recipient()`, which is
// the method the oracle view-calls before it will probe, confirm or pay.
const claimantSrc = readFileSync(new URL('./claimant.py', import.meta.url),'utf8')
const dep = await submit(()=>prov.deployContract({ code: claimantSrc, args: [ORACLE] }))
const depR = await prov.waitForTransactionReceipt({hash:dep,status:'ACCEPTED',interval:5000,retries:300})
const SINK = depR.data?.contract_address ?? depR.recipient
console.log(`    recipient  ${SINK}`)
for (let i=0;i<60;i++){ try { await client.readContract({address:SINK,functionName:'credent_recipient',args:[]}); break } catch { await sleep(5000) } }
check(String(await client.readContract({address:SINK,functionName:'credent_recipient',args:[]}))==='credent-recipient-v1',
  'it answers credent_recipient(), which a wallet cannot')

await send(prov,'assign_to',[addr(SINK)],0n,'assign_to — the wallet hands its entitlement to the recipient')
const assigned = await settle(async()=>big(await view('owed_to',[SINK.toLowerCase()])), v=>v>0n)
check(assigned===owed0,`the recipient is owed ${gen(assigned)} and the wallet nothing`)

// The handshake moves no value. What makes the recipient eligible is the view
// call the oracle makes into it for `credent_recipient()`.
await sendTo(prov,SINK,'prove',[],'prove — open the payout handshake')
await sendTo(prov,SINK,'confirm',[],'confirm — close it')
const proven = await settle(async()=>((await view('is_proven',[SINK.toLowerCase()]))?1n:0n), v=>v===1n)
check(proven===1n,'the recipient is proven')
const afterProbe = big(await view('owed_to',[SINK.toLowerCase()]))
check(afterProbe===assigned,`and the whole entitlement is still on the books (${gen(afterProbe)})`)

console.log(`\n  clause 2: withdraw parks the entitlement, it does not clear it`)
await sendTo(prov,SINK,'claim',[],'withdraw')
await settle(async()=>big(await view('owed_to',[SINK.toLowerCase()])), v=>v===0n)
const inflight = big(await view('in_flight_to',[SINK.toLowerCase()]))
check(big(await view('owed_to',[SINK.toLowerCase()]))===0n,'owed is zero — as the review describes')
check(inflight===afterProbe,`but the entitlement is parked in flight (${gen(inflight)}), not discarded`)

console.log(`\n  clause 3: reclaim is the restoration path`)
// `reclaim` refuses to judge a withdrawal younger than the policy's settle
// window. Waiting it out is the point rather than an inconvenience: judging
// before the transfer has landed or failed is the one way a recovery path can
// pay twice.
const pol = await view('get_policy')
const settleSeconds = Number(big(pol.withdrawal_settle_seconds))
console.log(`    settle window ${settleSeconds}s — waiting for the withdrawal to become resolvable`)
await settle(async()=>((await view('withdrawal_of',[SINK.toLowerCase()])).resolvable_now?1n:0n),
             v=>v===1n, (settleSeconds + 300) * 1000)
const held = await settle(async()=>big(await client.readContract({address:SINK,functionName:'total_received',args:[]})), v=>v>0n, 8*60*1000)
console.log(`    the recipient has received ${gen(held)} in total`)
await send(prov,'reclaim',[],0n,'reclaim — from the wallet, which has nothing in flight').catch(()=>console.log('      threw'))
await sendTo(prov,SINK,'settle_withdrawal',[],'reclaim — from the recipient')
const flightAfter = await settle(async()=>big(await view('in_flight_to',[SINK.toLowerCase()])), v=>v===0n)
check(flightAfter===0n,'the in-flight withdrawal was resolved')
check(big(await view('owed_to',[SINK.toLowerCase()]))===0n,
  'and nothing was credited back, because the value arrived — reclaim settled it rather than paying twice')

const l = await view('liabilities')
console.log(`    liabilities  owed ${gen(big(l.total_owed))}  in_flight ${gen(big(l.total_in_flight))}  ` +
            `bonds ${gen(big(l.total_bond))}  collateral ${gen(big(l.total_collateral))}`)
console.log(`                 obligations ${gen(big(l.obligations))}  slashed ${gen(big(l.slashed))}  ` +
            `committed ${gen(big(l.committed))}  held ${gen(big(l.held))}`)
// `obligations` less what is in flight: a withdrawal leaves the balance when it
// is emitted while the claim stays counted until `reclaim` resolves it, so
// `held` is legitimately short by that amount in between. Nothing is in flight
// at this point, so the two figures are the same here — the subtraction is
// written out because the invariant is the one that always holds, not the one
// that happens to hold now.
check(big(l.held)>=big(l.committed)-big(l.total_in_flight),
  'the contract still covers everything it has not sent — bonds, collateral and the slashings included, not just entitlements')

console.log(`\n  and reclaim cannot be replayed`)
// Judged on state, not on whether the call threw. A rejected transaction still
// reaches ACCEPTED -- consensus agreeing on a refusal is a success for the
// network -- and bradbury serves no receipt to read the reason from.
const owedBeforeReplay = big(await view('owed_to',[SINK.toLowerCase()]))
await sendTo(prov,SINK,'settle_withdrawal',[],'reclaim again (expected to be refused)').catch(()=>console.log('      threw'))
await sleep(30000)
const owedAfterReplay = big(await view('owed_to',[SINK.toLowerCase()]))
console.log(`    owed ${gen(owedBeforeReplay)} -> ${gen(owedAfterReplay)}`)
check(owedAfterReplay === owedBeforeReplay, 'a second reclaim credited nothing')

proxy.stop()
console.log(failures===0 ? '\nrecovery ok — the reported bypass is closed, the entitlement is parked rather than cleared, and reclaim resolves it'
                         : `\n${failures} check(s) FAILED`)
process.exit(failures===0?0:1)
