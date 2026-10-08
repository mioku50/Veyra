import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync,writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { createPublicClient,createWalletClient,erc20Abi,http,parseAbi,parseEther,toHex,type Address,type Hex } from "viem";
import { METROPOLIS_DEPLOYMENT,METROPOLIS_FACTORY_ABI } from "../../lib/monad/account.ts";
import { getMonadReadClient,readMonadAgentIdentity } from "../../lib/monad/erc8004.ts";
import { collectMonadEvidence } from "../../lib/monad/evidence.ts";
import { monadDemoTestnet,MONAD_CONTRACTS } from "../../lib/monad/config.ts";
import { METROPOLIS_ORIGIN } from "../../lib/monad/passkey.ts";
import { issuePurchaseQuote } from "../../lib/monad/purchase-issuer.ts";
import { parsePaymentApproval,purchaseRequestHash,simulatePaymentApproval,verifyPurchaseState } from "../../lib/monad/payment.ts";
import { verifyPaymentReceipt } from "../../lib/monad/payment-receipt.ts";
import { evaluateMonadPurchase } from "../../lib/monad/trust.ts";
import { planApprovedPayment } from "./relay-plan.mts";
import { mockClient,policy,assessment,publicTestAttester } from "./trust-tests.mts";

// All writes are to a disposable localhost fork. History is explicitly synthetic.
// The virtual browser authenticator performs real WebAuthn/P256 cryptography.
const localOrigin=process.env.METROPOLIS_E2E_ORIGIN??"http://127.0.0.1:3126";
assert.ok(["localhost","127.0.0.1"].includes(new URL(localOrigin).hostname)||localOrigin===METROPOLIS_ORIGIN,
  "Load the local build or the exact canonical Veyra frontend; all chain writes still use localhost.");
const rpc="http://127.0.0.1:18555";
const fundingSource=process.env.METROPOLIS_TEST_FUNDING_SOURCE as Address;
assert.ok(/^0x[0-9a-fA-F]{40}$/.test(fundingSource??""),"Provide a public funded address for the fork-only test.");
const live=getMonadReadClient();
const forkBlock=process.env.METROPOLIS_TEST_FORK_BLOCK??(await live.getBlock({blockTag:"finalized"})).number.toString();
assert.ok(/^\d+$/.test(forkBlock));
const upstreamErrors:string[]=[],upstreamMethods=new Set<string>();
writeFileSync(".local-tools/purchase-fork-rpc.log","");
const readMethods=new Set(["eth_chainId","eth_blockNumber","eth_getBlockByNumber","eth_getBlockByHash","eth_getBalance",
  "eth_getCode","eth_getStorageAt","eth_getTransactionCount","eth_getTransactionReceipt","eth_call","eth_getLogs","eth_gasPrice"]);
const upstream=createServer(async(request,response)=>{
  try {
    let body="";for await(const chunk of request)body+=chunk;
    const payload=JSON.parse(body),items=Array.isArray(payload)?payload:[payload];
    // Anvil probes an optional account-info optimization. This RPC exposes the
    // ordinary balance/code/nonce methods; use Anvil's standard fallback promptly.
    if(!Array.isArray(payload)&&payload.method==="eth_getAccountInfo") {
      response.writeHead(200,{"content-type":"application/json"});
      response.end(JSON.stringify({jsonrpc:"2.0",id:payload.id,error:{code:-32601,message:"Use standard account read methods"}}));return;
    }
    for(const item of items){assert.ok(readMethods.has(item.method),`Unexpected upstream method: ${item.method}`);upstreamMethods.add(item.method);}
    appendFileSync(".local-tools/purchase-fork-rpc.log",`${Date.now()} start ${body}\n`);
    const result=await fetch("https://testnet-rpc.monad.xyz",{method:"POST",headers:{"content-type":"application/json"},body,signal:AbortSignal.timeout(15000)});
    const output=await result.text();
    appendFileSync(".local-tools/purchase-fork-rpc.log",`${Date.now()} done ${items.map(item=>item.id).join(",")} ${result.status} ${output.slice(0,200)}\n`);
    if(!result.ok)upstreamErrors.push(`${items.map(item=>item.method).join(",")}: HTTP ${result.status}`);
    response.writeHead(result.status,{"content-type":"application/json"});response.end(output);
  } catch(error){upstreamErrors.push(String(error));response.writeHead(502);response.end("Upstream read failed");}
});
await new Promise<void>(resolve=>upstream.listen(18556,"127.0.0.1",resolve));
const anvil=spawn(".local-tools/foundry-1.8.5/anvil",["--network","monad","--chain-id","10143","--port","18555","--host","127.0.0.1",
  "--fork-url","http://127.0.0.1:18556","--fork-block-number",forkBlock,"--fork-state-by-number","--no-fork-node-info","--silent"],{stdio:["ignore","ignore","pipe"]});
anvil.stderr.on("data",data=>upstreamErrors.push(String(data)));
// A cold fork can fetch uncached historical storage more slowly than live RPC.
const fork=createPublicClient({chain:monadDemoTestnet,transport:http(rpc,{timeout:120_000,retryCount:0})});
const wallet=createWalletClient({account:publicTestAttester,chain:monadDemoTestnet,transport:http(rpc,{timeout:120_000,retryCount:0})});
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
let id=0;
async function localRpc(method:string,params:unknown[]=[]){
  assert.equal(new URL(rpc).hostname,"127.0.0.1");
  const response=await fetch(rpc,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:++id,method,params})});
  const payload=await response.json();if(payload.error)throw new Error(`${method}: ${payload.error.message}`);return payload.result;
}
async function finalizeLocal(blockNumber:bigint){
  await localRpc("anvil_mine",["0x2"]);
  if((await fork.getBlock({blockTag:"finalized"})).number<blockNumber)await localRpc("anvil_mine",["0x40"]);
  assert.ok((await fork.getBlock({blockTag:"finalized"})).number>=blockNumber);
}
try {
  for(let attempt=0;attempt<100;attempt++){
    try {if(await localRpc("eth_chainId")==="0x279f")break;}catch{}
    if(attempt===99)throw new Error("Local Monad fork did not start");
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  assert.equal(await fork.getChainId(),10143);
  // Preload native precompile account metadata before EVM execution. Anvil's
  // synchronous EVM path can stall on a cold remote account fetch. No code,
  // balance or verifier is overridden by these ordinary reads.
  for(const value of [1,2,256]) {
    const address=toHex(value,{size:20});
    await fork.getBalance({address});await fork.getCode({address});await fork.getTransactionCount({address});
  }
  await localRpc("anvil_setBalance",[publicTestAttester.address,toHex(parseEther("100"))]);
  const admin="0x861FBe92678Bd6421aCee2dC37b50FDe1Dc01A1E";
  await localRpc("anvil_impersonateAccount",[admin]);
  await localRpc("anvil_setBalance",[admin,toHex(parseEther("100"))]);
  const adminWallet=createWalletClient({account:admin,chain:monadDemoTestnet,transport:http(rpc)});
  const roleAbi=parseAbi(["function setAttester(address attester,bool active)"]);
  const roleHash=await adminWallet.writeContract({address:METROPOLIS_DEPLOYMENT.trustGate,abi:roleAbi,functionName:"setAttester",args:[publicTestAttester.address,true]});
  await finalizeLocal((await fork.waitForTransactionReceipt({hash:roleHash})).blockNumber);
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage(),errors:string[]=[],rpcErrors:string[]=[],nativeResults:unknown[]=[],methods=new Set<string>();
  page.on("pageerror",error=>errors.push(error.message));
  await context.route(`${METROPOLIS_ORIGIN}/**`,async route=>{
    const response=await route.fetch({url:route.request().url().replace(METROPOLIS_ORIGIN,localOrigin)});await route.fulfill({response});
  });
  await context.route("https://testnet-rpc.monad.xyz/**",async route=>{
    const payload=route.request().postDataJSON();
    for(const item of Array.isArray(payload)?payload:[payload])methods.add(item.method);
    const response=await fetch(rpc,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
    const body=await response.text();
    const calls=Array.isArray(payload)?payload:[payload];
    if(calls.some(item=>item.method==="eth_call"&&item.params?.[0]?.to?.toLowerCase().endsWith("0100")))nativeResults.push(JSON.parse(body));
    for(const result of Array.isArray(JSON.parse(body))?JSON.parse(body):[JSON.parse(body)])if(result.error)rpcErrors.push(result.error.message);
    await route.fulfill({status:response.status,contentType:"application/json",body});
  });
  const cdp=await context.newCDPSession(page);await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator",{options:{protocol:"ctap2",transport:"internal",hasResidentKey:true,
    hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  await page.goto(`${METROPOLIS_ORIGIN}/metropolis`,{waitUntil:"networkidle"});
  if(await page.getByRole("button",{name:"Create test passkey"}).isDisabled()) {
    console.log(JSON.stringify({browserErrors:errors,status:await page.getByRole("status").allTextContents(),
      context:await page.evaluate(()=>({origin:location.origin,secure:isSecureContext,hasCredential:"PublicKeyCredential" in window,credentials:!!navigator.credentials}))}));
  }
  await page.getByRole("button",{name:"Create test passkey"}).click();
  await page.getByRole("button",{name:"Verify on Monad",exact:true}).waitFor({timeout:20000});
  const credential=await page.evaluate(()=>JSON.parse(localStorage.getItem("veyra.metropolis.public-credential.v1")!)) as {publicKey:Hex};
  const qx=`0x${credential.publicKey.slice(2,66)}` as Hex,qy=`0x${credential.publicKey.slice(66)}` as Hex;
  const {METROPOLIS_ACCOUNT_SALT}=await import("../../lib/monad/account.ts");
  const createHash=await wallet.writeContract({address:METROPOLIS_DEPLOYMENT.factory,abi:METROPOLIS_FACTORY_ABI,functionName:"createAccount",args:[qx,qy,METROPOLIS_ACCOUNT_SALT]});
  await finalizeLocal((await fork.waitForTransactionReceipt({hash:createHash})).blockNumber);
  const account=await fork.readContract({address:METROPOLIS_DEPLOYMENT.factory,abi:METROPOLIS_FACTORY_ABI,functionName:"accountAddress",args:[qx,qy,METROPOLIS_ACCOUNT_SALT]});
  await localRpc("anvil_impersonateAccount",[fundingSource]);await localRpc("anvil_setBalance",[fundingSource,toHex(parseEther("100"))]);
  const fundingWallet=createWalletClient({account:fundingSource,chain:monadDemoTestnet,transport:http(rpc)});
  const fundingHash=await fundingWallet.writeContract({address:MONAD_CONTRACTS[10143].usdc,abi:erc20Abi,functionName:"transfer",args:[account,1_000_000n]});
  await finalizeLocal((await fork.waitForTransactionReceipt({hash:fundingHash})).blockNumber);
  await page.getByRole("button",{name:"Verify on Monad",exact:true}).click();
  try {await page.getByRole("status").filter({hasText:"Monad verified its P256 signature"}).waitFor({timeout:45000});}
  catch(error){console.log(JSON.stringify({browserErrors:errors,rpcErrors,nativeResults,methods:[...methods],status:await page.getByRole("status").allTextContents()}));throw error;}
  await page.getByRole("button",{name:"Prepare account",exact:true}).click();
  await page.getByTestId("account-address").waitFor({timeout:45000});
  assert.equal(await page.getByTestId("account-address").textContent(),account);
  const agent=await readMonadAgentIdentity(1n,fork,"finalized");
  await localRpc("evm_setNextBlockTimestamp",[Math.floor(Date.now()/1000)+1]);await localRpc("evm_mine");
  const now=new Date(Number((await fork.getBlock({blockTag:"latest"})).timestamp)*1000),clock=Math.floor(now.getTime()/1000);
  const task={serviceId:"local-fork-fixture",request:"Local fork test of an exact purchase",deliverable:"Synthetic test output; no external service is called"};
  const intent={executor:account,amountUsdc:"0.012",budgetUsdc:"0.02",serviceId:task.serviceId,requestHash:purchaseRequestHash(task)};
  const identityOnly=await collectMonadEvidence(1n,{},fork,now);
  const blocked=evaluateMonadPurchase(identityOnly,intent,now);
  assert.equal(blocked.executable,false);
  await assert.rejects(issuePurchaseQuote(blocked,{publicKey:credential.publicKey,task,budgetUsdc:"0.02",agentId:"1",demonstration:true},publicTestAttester,fork,now),/server-issued/);
  const bundle=await collectMonadEvidence(1n,{...policy,assessments:[await assessment({seller:agent.paymentWallet,assessedAt:BigInt(clock-20)})]},
    mockClient({clock,owner:agent.owner,wallet:agent.paymentWallet,recipient:agent.paymentWallet}),now);
  const decision=evaluateMonadPurchase(bundle,intent,now);
  const quote=await issuePurchaseQuote(decision,{publicKey:credential.publicKey,task,budgetUsdc:"0.02",agentId:"1",demonstration:true},publicTestAttester,fork,now);
  const proposal=page.getByLabel("Signed purchase proposal or saved payment approval");
  await proposal.fill(JSON.stringify({...quote,task:{...task,request:"Tampered task"}}));
  await page.getByRole("button",{name:"Check proposal",exact:true}).click();
  await page.getByRole("status").filter({hasText:"signature does not match"}).waitFor({timeout:20000});
  assert.equal(await page.getByTestId("validated-purchase").count(),0);
  await proposal.fill(JSON.stringify(quote));await page.getByRole("button",{name:"Check proposal",exact:true}).click();
  await page.getByTestId("validated-purchase").waitFor({timeout:45000});
  await page.getByRole("button",{name:"Approve 0.012 USDC with passkey",exact:true}).click();
  await page.getByLabel("Approved payment JSON").waitFor({state:"attached",timeout:45000});
  const approval=parsePaymentApproval(JSON.parse(await page.getByLabel("Approved payment JSON").inputValue()));
  await context.grantPermissions(["clipboard-read","clipboard-write"],{origin:METROPOLIS_ORIGIN});
  await page.getByRole("button",{name:"Copy approved payment",exact:true}).click();
  assert.deepEqual(JSON.parse(await page.evaluate(()=>navigator.clipboard.readText())),approval);
  const plan=await planApprovedPayment(approval,publicTestAttester.address,fork);
  const tx=plan.transaction;
  const paid=await wallet.sendTransaction({to:tx.to,data:tx.data,nonce:tx.nonce,value:0n,gas:BigInt(tx.gas),
    maxFeePerGas:BigInt(tx.maxFeePerGas),maxPriorityFeePerGas:BigInt(tx.maxPriorityFeePerGas)});
  await finalizeLocal((await fork.waitForTransactionReceipt({hash:paid})).blockNumber);
  const receipt=await verifyPaymentReceipt(approval,paid,fork);assert.equal(receipt.payment,"confirmed");assert.equal(receipt.delivery,"not_assessed");
  await assert.rejects(simulatePaymentApproval(approval,fork),/nonce changed|already consumed/);
  await assert.rejects(verifyPaymentReceipt(approval,fundingHash,fork));
  await page.getByLabel("Transaction hash from the relayer").fill(paid);await page.getByRole("button",{name:"Verify payment receipt",exact:true}).click();
  await page.getByTestId("confirmed-purchase").waitFor({timeout:45000});
  await page.reload({waitUntil:"networkidle"});await page.getByRole("button",{name:"Verify on Monad",exact:true}).click();
  try {await page.getByRole("status").filter({hasText:"Monad verified its P256 signature"}).waitFor({timeout:45000});}
  catch(error){console.log(JSON.stringify({stage:"reload",browserErrors:errors,rpcErrors,nativeResults,methods:[...methods],status:await page.getByRole("status").allTextContents()}));throw error;}
  await page.getByRole("button",{name:"Prepare account",exact:true}).click();await page.getByTestId("account-address").waitFor({timeout:45000});
  await page.getByLabel("Signed purchase proposal or saved payment approval").fill(JSON.stringify(approval));
  await page.getByRole("button",{name:"Check proposal",exact:true}).click();
  await page.getByRole("status").filter({hasText:"Saved approval loaded"}).waitFor();
  await page.getByLabel("Transaction hash from the relayer").fill(paid);await page.getByRole("button",{name:"Verify payment receipt",exact:true}).click();
  await page.getByTestId("confirmed-purchase").waitFor({timeout:45000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  assert.deepEqual(errors,[]);
  assert.deepEqual([...methods].filter(method=>!['eth_chainId','eth_getCode','eth_getBlockByNumber','eth_call',
    'eth_getTransactionReceipt','eth_getTransactionByHash'].includes(method)),[],"Browser uses only read methods, including receipt reads");
  const left=await fork.readContract({address:MONAD_CONTRACTS[10143].usdc,abi:erc20Abi,functionName:"balanceOf",args:[account]});
  assert.equal(left,988_000n);
  console.log(JSON.stringify({result:"PASS",scope:"disposable localhost Monad fork only",frontendOrigin:localOrigin,forkBlock,virtualWebAuthn:true,
    nativeP256AccountExecution:true,amountUsdc:"0.012",receiptVerified:true,replayRejected:true,
    tamperedTaskRejected:true,identityOnlyBlocked:true,receiptRestoredAfterReload:true,externalTransactionsSent:0,serviceDelivery:"not assessed"}));
}catch(error){
  console.log(JSON.stringify({upstreamErrors,upstreamMethods:[...upstreamMethods]}));throw error;
}finally {
  await browser?.close();anvil.kill("SIGTERM");upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));
}
