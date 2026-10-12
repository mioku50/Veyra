import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync,writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { createPublicClient,createWalletClient,encodeAbiParameters,erc20Abi,http,keccak256,parseAbi,parseEther,toHex,type Address,type Hex } from "viem";
import { generatePrivateKey,privateKeyToAccount } from "viem/accounts";
import { METROPOLIS_DEPLOYMENT,METROPOLIS_V2_DEPLOYMENT,METROPOLIS_V2_ACCOUNT_SALT,METROPOLIS_FACTORY_ABI } from "../../lib/monad/account.ts";
import { getMonadReadClient,readMonadAgentIdentity } from "../../lib/monad/erc8004.ts";
import { collectMonadEvidence } from "../../lib/monad/evidence.ts";
import { monadDemoTestnet,MONAD_CONTRACTS } from "../../lib/monad/config.ts";
import { METROPOLIS_ORIGIN } from "../../lib/monad/passkey.ts";
import { issuePurchaseQuote } from "../../lib/monad/purchase-issuer.ts";
import { parsePaymentApproval,purchaseRequestHash,simulatePaymentApproval,verifyPurchaseState } from "../../lib/monad/payment.ts";
import { verifyPaymentReceipt } from "../../lib/monad/payment-receipt.ts";
import { generateReadinessReport,readinessTask,readinessResponseHash } from "../../lib/monad/readiness.ts";
import { planReadinessRegistration,verifyReadinessRegistrationReceipt } from "../../lib/monad/readiness-registration.ts";
import { fulfillReadinessPurchase,planReadinessAssessment,verifyReadinessDelivery } from "../../lib/monad/readiness-delivery.ts";
import { checkReadinessTrialOrder,fulfillReadinessTrial,planReadinessTrial,planReadinessTrialAssessment,readinessTrialOrder,
  verifyReadinessTrialDelivery,verifyReadinessTrialReceipt } from "../../lib/monad/readiness-trial.ts";
import { buildMonadClearance,evaluateMonadPurchase } from "../../lib/monad/trust.ts";
import { planApprovedPayment } from "./relay-plan.mts";
import { assessment,publicTestAttester } from "./trust-tests.mts";

// All writes are to a disposable localhost fork. Initial history comes from an
// actual local trial/result, with a test buyer score, never from fabricated receipts.
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
assert.ok(BigInt(forkBlock)>=70207992n,"The V2 browser test needs a fork at or after its verified factory deployment.");
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
  await context.addInitScript(()=>{
    const originalGet=navigator.credentials.get.bind(navigator.credentials);
    const testWindow=window as unknown as {assertionDiagnostics:unknown[];forcedCredentialId?:string};
    testWindow.assertionDiagnostics=[];
    navigator.credentials.get=async options=>{
      const diagnostics=testWindow.assertionDiagnostics;
      // Record the real application's request. Select a real virtual credential
      // for each test case without replacing its signature or the native verifier.
      const request={allowedCredentials:options?.publicKey?.allowCredentials?.length??0,
        rpId:options?.publicKey?.rpId,userVerification:options?.publicKey?.userVerification,
        userActivation:navigator.userActivation.isActive};
      let actualOptions=options;
      if(testWindow.forcedCredentialId&&options?.publicKey) {
        const id=Uint8Array.from(atob(testWindow.forcedCredentialId.replaceAll("-","+").replaceAll("_","/")),char=>char.charCodeAt(0));
        actualOptions={...options,publicKey:{...options.publicKey,allowCredentials:[{type:"public-key",id}]}};
      }
      try {
        const result=await originalGet(actualOptions);
        if(result instanceof PublicKeyCredential&&result.response instanceof AuthenticatorAssertionResponse) {
          diagnostics.push({...request,credentialId:result.id,clientDataJSON:new TextDecoder().decode(result.response.clientDataJSON),
            flags:new Uint8Array(result.response.authenticatorData)[32],signatureLength:result.response.signature.byteLength});
        }
        return result;
      }catch(error){diagnostics.push({error:error instanceof Error?error.message:String(error)});throw error;}
    };
  });
  const page=await context.newPage(),errors:string[]=[],rpcErrors:string[]=[],nativeResults:unknown[]=[],methods=new Set<string>();
  let selectionPreflightDelay=0;
  let selectionPreflightAccount:Address|undefined;
  let selectionPreflightDelayed=false;
  page.on("pageerror",error=>errors.push(error.message));
  await context.route(`${METROPOLIS_ORIGIN}/**`,async route=>{
    const response=await route.fetch({url:route.request().url().replace(METROPOLIS_ORIGIN,localOrigin)});await route.fulfill({response});
  });
  await context.route("https://testnet-rpc.monad.xyz/**",async route=>{
    const payload=route.request().postDataJSON();
    const calls=Array.isArray(payload)?payload:[payload];
    // Delay the awaited read of this specific account, rather than a cached
    // chain-ID lookup or an unrelated in-flight/background request.
    if(selectionPreflightDelay&&calls.some(item=>item.method==="eth_getCode"
      &&item.params?.[0]?.toLowerCase()===selectionPreflightAccount?.toLowerCase())) {
      const delay=selectionPreflightDelay;selectionPreflightDelay=0;
      await new Promise(resolve=>setTimeout(resolve,delay));
      selectionPreflightDelayed=true;
    }
    for(const item of Array.isArray(payload)?payload:[payload])methods.add(item.method);
    const response=await fetch(rpc,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
    const body=await response.text();
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
  const credential=await page.evaluate(()=>JSON.parse(localStorage.getItem("veyra.metropolis.public-credential.v1")!)) as {id:string;publicKey:Hex;origin:string};
  const qx=`0x${credential.publicKey.slice(2,66)}` as Hex,qy=`0x${credential.publicKey.slice(66)}` as Hex;
  const createHash=await wallet.writeContract({address:METROPOLIS_V2_DEPLOYMENT.factory,abi:METROPOLIS_FACTORY_ABI,functionName:"createAccount",args:[qx,qy,METROPOLIS_V2_ACCOUNT_SALT]});
  await finalizeLocal((await fork.waitForTransactionReceipt({hash:createHash})).blockNumber);
  const account=await fork.readContract({address:METROPOLIS_V2_DEPLOYMENT.factory,abi:METROPOLIS_FACTORY_ABI,functionName:"accountAddress",args:[qx,qy,METROPOLIS_V2_ACCOUNT_SALT]});
  await localRpc("anvil_impersonateAccount",[fundingSource]);await localRpc("anvil_setBalance",[fundingSource,toHex(parseEther("100"))]);
  const fundingWallet=createWalletClient({account:fundingSource,chain:monadDemoTestnet,transport:http(rpc)});
  const fundingHash=await fundingWallet.writeContract({address:MONAD_CONTRACTS[10143].usdc,abi:erc20Abi,functionName:"transfer",args:[account,1_000_000n]});
  await finalizeLocal((await fork.waitForTransactionReceipt({hash:fundingHash})).blockNumber);
  // Reproduce the user's other-browser metadata: a second resident credential
  // is currently saved, while the first credential owns the funded V2 account.
  const otherCredential=await page.evaluate(async()=>{
    const raw=await navigator.credentials.create({publicKey:{rp:{id:location.hostname,name:"Veyra existing-key fork test"},
      user:{id:crypto.getRandomValues(new Uint8Array(32)),name:"other-local-key",displayName:"Other local key"},
      challenge:crypto.getRandomValues(new Uint8Array(32)),pubKeyCredParams:[{type:"public-key",alg:-7}],
      authenticatorSelection:{authenticatorAttachment:"platform",residentKey:"required",userVerification:"required"}}}) as PublicKeyCredential;
    const spki=(raw.response as AuthenticatorAttestationResponse).getPublicKey();if(!spki)throw new Error("No public key");
    const key=await crypto.subtle.importKey("spki",spki,{name:"ECDSA",namedCurve:"P-256"},true,["verify"]);
    const bytes=new Uint8Array(await crypto.subtle.exportKey("raw",key));
    const saved={id:raw.id,publicKey:`0x${Array.from(bytes.slice(1),x=>x.toString(16).padStart(2,"0")).join("")}`,origin:location.origin};
    localStorage.setItem("veyra.metropolis.public-credential.v1",JSON.stringify(saved));return saved;
  });
  assert.notEqual(otherCredential.id,credential.id);
  await page.goto(`${METROPOLIS_ORIGIN}/metropolis?account=${account}`,{waitUntil:"networkidle"});
  await page.getByRole("button",{name:"Check existing account",exact:true}).waitFor();
  assert.equal(await page.getByLabel("Existing V2 account address").inputValue(),account);
  async function assertRequestedAccountPending() {
    assert.equal(await page.getByRole("button",{name:"Verify on Monad",exact:true}).count(),0,
      "A saved-key verification cannot bypass selection of the requested account");
    assert.equal(await page.getByRole("button",{name:"Create test passkey",exact:true}).count(),0);
    assert.equal(await page.getByRole("button",{name:"Prepare account",exact:true}).count(),0);
    assert.equal(await page.getByRole("button",{name:"Copy public account details",exact:true}).count(),0);
    assert.equal(await page.getByLabel("Public account setup JSON").count(),0);
    assert.equal(await page.getByTestId("account-address").count(),0);
    assert.equal(await page.getByTestId("requested-account-address").textContent(),account);
  }
  await assertRequestedAccountPending();
  assert.deepEqual(await page.evaluate(()=>(window as unknown as {assertionDiagnostics:unknown[]}).assertionDiagnostics),[],
    "An account URL only prefills the form; it never prompts or signs automatically");
  await page.getByLabel("Existing V2 account address").fill(publicTestAttester.address);
  await page.getByRole("button",{name:"Check existing account",exact:true}).click();
  await page.getByRole("alert").filter({hasText:"does not have a deployed V2 account"}).waitFor({timeout:45000});
  assert.deepEqual(await page.evaluate(()=>(window as unknown as {assertionDiagnostics:unknown[]}).assertionDiagnostics),[],
    "An undeployed address is rejected before the browser asks for a passkey");
  await page.getByLabel("Existing V2 account address").fill(account);
  selectionPreflightDelay=11000;
  selectionPreflightAccount=account;
  const preparationStarted=performance.now();
  await page.getByRole("button",{name:"Check existing account",exact:true}).click();
  await page.getByRole("status").filter({hasText:"Existing V2 account checked"}).waitFor({timeout:45000});
  assert.equal(selectionPreflightDelayed,true,"The target-account code read actually received the injected delay");
  assert.ok(performance.now()-preparationStarted>=11000,"Preparation intentionally outlasts WebKit's documented fetch gesture window");
  assert.deepEqual(await page.evaluate(()=>(window as unknown as {assertionDiagnostics:unknown[]}).assertionDiagnostics),[],
    "Account preparation does not prompt for a passkey");
  await assertRequestedAccountPending();
  await page.getByText("Balance checked; passkey selection still required.",{exact:false}).waitFor();
  await page.evaluate(id=>{(window as unknown as {forcedCredentialId:string}).forcedCredentialId=id;},otherCredential.id);
  await page.getByRole("button",{name:"Select existing passkey",exact:true}).click();
  await page.getByRole("alert").filter({hasText:"The selected passkey does not belong to this account"}).waitFor({timeout:45000});
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem("veyra.metropolis.public-credential.v1")!)),otherCredential,
    "A real signature from the wrong key cannot replace the saved credential");
  await assertRequestedAccountPending();
  await page.getByText("No account switch was completed.",{exact:false}).waitFor();
  await page.evaluate(id=>{(window as unknown as {forcedCredentialId:string}).forcedCredentialId=id;},credential.id);
  // A matching real assertion is insufficient if saving its public pointer
  // fails. Report storage failure distinctly and keep the original pointer.
  await page.evaluate(()=>{
    const original=Storage.prototype.setItem;
    (window as unknown as {originalSetItem:typeof original}).originalSetItem=original;
    Storage.prototype.setItem=function(key,value) {
      if(key==="veyra.metropolis.public-credential.v1")throw new DOMException("Test storage failure","QuotaExceededError");
      original.call(this,key,value);
    };
  });
  await page.getByRole("button",{name:"Select existing passkey",exact:true}).click();
  await page.getByRole("alert").filter({hasText:"browser could not save its public details"}).waitFor({timeout:45000});
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem("veyra.metropolis.public-credential.v1")!)),otherCredential);
  await assertRequestedAccountPending();
  await page.evaluate(()=>{Storage.prototype.setItem=(window as unknown as {originalSetItem:typeof Storage.prototype.setItem}).originalSetItem;});
  await page.getByRole("button",{name:"Select existing passkey",exact:true}).click();
  await page.getByRole("status").filter({hasText:"The existing passkey matches this V2 account"}).waitFor({timeout:45000});
  assert.equal(await page.getByTestId("account-address").textContent(),account);
  const selectedState=await page.evaluate(()=>({
    current:JSON.parse(localStorage.getItem("veyra.metropolis.public-credential.v1")!),
    previous:JSON.parse(localStorage.getItem("veyra.metropolis.previous-public-credential.v1")!),
    assertions:(window as unknown as {assertionDiagnostics:{allowedCredentials:number;rpId:string;userVerification:string;userActivation:boolean}[]}).assertionDiagnostics,
  }));
  assert.deepEqual(selectedState.current,credential);assert.deepEqual(selectedState.previous,otherCredential);
  assert.equal(selectedState.assertions.length,3);
  for(const request of selectedState.assertions){assert.equal(request.allowedCredentials,0);
    assert.equal(request.rpId,new URL(METROPOLIS_ORIGIN).hostname);assert.equal(request.userVerification,"required");
    assert.equal(request.userActivation,true,"The browser prompt starts in a fresh user gesture after slow preparation");}
  assert.equal(await fork.readContract({address:account,abi:parseAbi(["function nonce() view returns(uint256)"]),functionName:"nonce"}),0n);
  assert.equal(await fork.readContract({address:MONAD_CONTRACTS[10143].usdc,abi:erc20Abi,functionName:"balanceOf",args:[account]}),1_000_000n);
  // Editing the target revokes the selected display and payment controls. Even
  // a previously verified account cannot leak into an export for a new target.
  await page.getByLabel("Existing V2 account address").fill(publicTestAttester.address);
  assert.equal(await page.getByTestId("account-address").count(),0);
  assert.equal(await page.getByRole("button",{name:"Copy public account details",exact:true}).count(),0);
  assert.equal(await page.getByLabel("Public account setup JSON").count(),0);
  await page.reload({waitUntil:"networkidle"});
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem("veyra.metropolis.public-credential.v1")!)),credential);
  await page.getByRole("button",{name:"Check existing account",exact:true}).waitFor();
  await assertRequestedAccountPending();
  // Leaving the requested-account flow is explicit and clears its URL target;
  // verifying the saved credential is then a separate, fresh user action.
  await page.getByRole("button",{name:"Cancel account selection and use the saved passkey",exact:true}).click();
  assert.equal(new URL(page.url()).searchParams.get("account"),null);
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem("veyra.metropolis.public-credential.v1")!)),credential);
  await page.getByRole("button",{name:"Verify on Monad",exact:true}).click();
  try {await page.getByRole("status").filter({hasText:"Monad verified its P256 signature"}).waitFor({timeout:45000});}
  catch(error){console.log(JSON.stringify({browserErrors:errors,rpcErrors,nativeResults,methods:[...methods],status:await page.getByRole("status").allTextContents(),assertions:await page.evaluate(()=>(window as unknown as {assertionDiagnostics:unknown[]}).assertionDiagnostics)}));throw error;}
  await page.getByRole("button",{name:"Prepare account",exact:true}).click();
  await page.getByTestId("account-address").waitFor({timeout:45000});
  assert.equal(await page.getByTestId("account-address").textContent(),account);
  // Own clearly labelled demonstration identity, minted only on the disposable fork.
  const provider=privateKeyToAccount(generatePrivateKey());
  await localRpc("anvil_setBalance",[provider.address,toHex(parseEther("100"))]);
  const providerWallet=createWalletClient({account:provider,chain:monadDemoTestnet,transport:http(rpc,{timeout:120000,retryCount:0})});
  const registrationPlan=await planReadinessRegistration(provider.address,fork),registrationTx=registrationPlan.transaction;
  const registrationHash=await providerWallet.sendTransaction({to:registrationTx.to,data:registrationTx.data,nonce:registrationTx.nonce,
    value:0n,gas:BigInt(registrationTx.gas),maxFeePerGas:BigInt(registrationTx.maxFeePerGas),maxPriorityFeePerGas:BigInt(registrationTx.maxPriorityFeePerGas)});
  await finalizeLocal((await fork.waitForTransactionReceipt({hash:registrationHash})).blockNumber);
  const registration=await verifyReadinessRegistrationReceipt(registrationPlan,registrationHash,fork);
  const agentId=BigInt(registration.agentId),agent=await readMonadAgentIdentity(agentId,fork,"finalized");
  assert.equal(registration.paymentWallet,provider.address);assert.equal(registration.reputationEstablished,false);
  await assert.rejects(verifyReadinessRegistrationReceipt(registrationPlan,fundingHash,fork));
  const originalRegistrationReceipt=await fork.getTransactionReceipt({hash:registrationHash});
  await assert.rejects(verifyReadinessRegistrationReceipt(registrationPlan,registrationHash,{...fork,
    getTransactionReceipt:async()=>({...originalRegistrationReceipt,logs:[...originalRegistrationReceipt.logs,...originalRegistrationReceipt.logs]})}));
  await assert.rejects(verifyReadinessRegistrationReceipt(registrationPlan,registrationHash,{...fork,
    getTransactionReceipt:async()=>({...originalRegistrationReceipt,logs:originalRegistrationReceipt.logs.map(log=>({...log,removed:true}))})}));
  await localRpc("evm_setNextBlockTimestamp",[Math.floor(Date.now()/1000)+1]);await localRpc("evm_mine");
  let now=new Date(Number((await fork.getBlock({blockTag:"latest"})).timestamp)*1000);
  const task=readinessTask({publicKey:credential.publicKey,budgetUsdc:"0.02",accountVersion:2});
  const preview=await generateReadinessReport(task,fork);
  console.log("Readiness fork: real registry registration and free preview verified; preparing owner approval.");
  const intent={executor:account,amountUsdc:"0.012",budgetUsdc:"0.02",serviceId:task.serviceId,requestHash:purchaseRequestHash(task)};
  const identityOnly=await collectMonadEvidence(agentId,{},fork,now);
  const blocked=evaluateMonadPurchase(identityOnly,intent,now);
  assert.equal(blocked.executable,false);
  await assert.rejects(issuePurchaseQuote(blocked,{publicKey:credential.publicKey,task,budgetUsdc:"0.02",agentId:agentId.toString(),demonstration:true},publicTestAttester,fork,now),/server-issued/);
  // An explicit EOA trial supplies actual transfer and delivered-result evidence
  // on the local fork. This is not a passkey approval or Veyra spending override.
  await fork.readContract({address:MONAD_CONTRACTS[10143].usdc,abi:erc20Abi,functionName:"balanceOf",args:[publicTestAttester.address]});
  const trialFunding=await fundingWallet.writeContract({address:MONAD_CONTRACTS[10143].usdc,abi:erc20Abi,functionName:"transfer",args:[publicTestAttester.address,100000n]});
  await finalizeLocal((await fork.waitForTransactionReceipt({hash:trialFunding})).blockNumber);
  await assert.rejects(planReadinessTrial({buyer:provider.address,agentId,task,amountUsdc:"0.012"},fork),/distinct/);
  await assert.rejects(planReadinessTrial({buyer:account,agentId,task,amountUsdc:"0.012"},fork),/EOA/);
  const trialPacket=await planReadinessTrial({buyer:publicTestAttester.address,agentId,task,amountUsdc:"0.012"},fork);
  assert.equal(trialPacket.plan.clearanceIssued,false);assert.equal(trialPacket.plan.policyDecision,"REVIEW_REQUIRED");
  const trialSignature=await publicTestAttester.signTypedData(readinessTrialOrder(trialPacket.plan));
  assert.equal((await checkReadinessTrialOrder(trialPacket.plan,trialSignature,fork)).transactionSent,false);
  const trialTransaction=trialPacket.plan.transaction;
  const trialHash=await wallet.sendTransaction({to:trialTransaction.to,data:trialTransaction.data,nonce:trialTransaction.nonce,value:0n,
    gas:BigInt(trialTransaction.gas),maxFeePerGas:BigInt(trialTransaction.maxFeePerGas),maxPriorityFeePerGas:BigInt(trialTransaction.maxPriorityFeePerGas)});
  await finalizeLocal((await fork.waitForTransactionReceipt({hash:trialHash})).blockNumber);
  const trialReceipt=await verifyReadinessTrialReceipt(trialPacket.plan,trialSignature,trialHash,fork);
  await assert.rejects(checkReadinessTrialOrder(trialPacket.plan,trialSignature,fork),/nonce/);
  assert.equal(trialReceipt.payment,"confirmed");assert.equal(trialReceipt.passkeyApproval,false);
  await assert.rejects(verifyReadinessTrialReceipt(trialPacket.plan,trialSignature,trialFunding,fork));
  await assert.rejects(verifyReadinessTrialReceipt(trialPacket.plan,await provider.signTypedData(readinessTrialOrder(trialPacket.plan)),trialHash,fork),/buyer must sign/);
  const trialDelivery=await fulfillReadinessTrial(trialPacket.plan,trialSignature,trialHash,fork);
  const savedTrial=JSON.parse(JSON.stringify(trialDelivery));
  await localRpc("anvil_mine",["0x2"]);
  const restoredTrial=await verifyReadinessTrialDelivery(savedTrial,trialPacket.plan,trialSignature,trialHash,fork);
  assert.equal(restoredTrial.responseHash,trialDelivery.responseHash);
  await assert.rejects(verifyReadinessTrialDelivery({...savedTrial,report:preview,responseHash:readinessResponseHash(preview)},trialPacket.plan,trialSignature,trialHash,fork),/prepayment/);
  const fabricatedTrialReport={...trialDelivery.report,account:{...trialDelivery.report.account,usdcBalanceUnits:"9000000"}};
  await assert.rejects(verifyReadinessTrialDelivery({...savedTrial,report:fabricatedTrialReport,responseHash:readinessResponseHash(fabricatedTrialReport)},trialPacket.plan,trialSignature,trialHash,fork),/canonical/);
  assert.throws(()=>planReadinessTrialAssessment(savedTrial,95),/Reverify/);
  for(const score of [-1,101,0.5])assert.throws(()=>planReadinessTrialAssessment(restoredTrial,score));
  now=new Date(Math.max(Date.now(),Number((await fork.getBlock({blockTag:"latest"})).timestamp)*1000));
  const trialAssessmentPlan=planReadinessTrialAssessment(restoredTrial,95,now); // Declared test score, not a real user's review.
  const trialMessage=trialAssessmentPlan.typedData.message;
  const signedTrialReport=await assessment({...trialMessage,agentId,amount:BigInt(trialMessage.amount),assessedAt:BigInt(trialMessage.assessedAt)},publicTestAttester);
  const bundle=await collectMonadEvidence(agentId,{payments:[trialAssessmentPlan.paymentReference],assessmentReporters:[publicTestAttester.address],assessments:[signedTrialReport]},fork,now);
  assert.ok(bundle.evidence.some(item=>item.type==="usdc_payment_success"));
  assert.ok(bundle.evidence.some(item=>item.type==="service_delivery"));
  console.log("Readiness fork: manual trial, actual result and signed test buyer assessment verified; evaluating the ordinary policy.");
  const decision=evaluateMonadPurchase(bundle,intent,now);
  // Warm the newly derived replay slot with an ordinary raw storage read before
  // concurrent EVM calls. Slot 3 is from the verified TrustGate storage layout.
  // This reads the actual fork state; it does not clear or override replay data.
  const unsignedClearance=buildMonadClearance(decision,METROPOLIS_DEPLOYMENT.trustGate,now);
  const replaySlot=keccak256(encodeAbiParameters([{type:"bytes32"},{type:"uint256"}],[unsignedClearance.digest,3n]));
  await fork.getStorageAt({address:METROPOLIS_DEPLOYMENT.trustGate,slot:replaySlot});
  await fork.readContract({address:MONAD_CONTRACTS[10143].usdc,abi:erc20Abi,functionName:"balanceOf",args:[agent.paymentWallet]});
  const quote=await issuePurchaseQuote(decision,{publicKey:credential.publicKey,task,budgetUsdc:"0.02",agentId:agentId.toString(),demonstration:true,
    factory:METROPOLIS_V2_DEPLOYMENT.factory},publicTestAttester,fork,now);
  const proposal=page.getByLabel("Signed purchase proposal or saved payment approval");
  await proposal.fill(JSON.stringify({...quote,task:{...task,request:"Tampered task"}}));
  await page.getByRole("button",{name:"Check proposal",exact:true}).click();
  await page.getByRole("status").filter({hasText:"signature does not match"}).waitFor({timeout:20000});
  assert.equal(await page.getByTestId("validated-purchase").count(),0);
  await proposal.fill(JSON.stringify(quote));await page.getByRole("button",{name:"Check proposal",exact:true}).click();
  await page.getByTestId("validated-purchase").waitFor({timeout:45000});
  await page.getByText("Check my Monad Testnet account, infrastructure and funding, and identify what still blocks a purchase.",{exact:true}).waitFor();
  await page.getByText("Exact signed request",{exact:true}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,"Expanded structured request must fit the mobile viewport");
  await page.getByText("Exact signed request",{exact:true}).click();
  // One genuine browser prompt. V2 preserves the entire assertion, including
  // optional JSON members; the product never retries or rewrites signed bytes.
  await page.getByRole("button",{name:"Approve 0.012 USDC with passkey",exact:true}).click();
  try {await page.getByLabel("Approved payment JSON").waitFor({state:"attached",timeout:45000});}
  catch(error){console.log(JSON.stringify({stage:"owner approval",browserErrors:errors,rpcErrors,nativeResults,methods:[...methods],status:await page.getByRole("status").allTextContents()}));throw error;}
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
  const delivery=await fulfillReadinessPurchase(approval,paid,fork);
  assert.equal((await verifyReadinessTrialDelivery(savedTrial,trialPacket.plan,trialSignature,trialHash,fork)).responseHash,trialDelivery.responseHash);
  assert.equal(delivery.report.account.usdcBalanceUnits,"988000");assert.equal(delivery.requestHash,purchaseRequestHash(task));
  const persisted=JSON.parse(JSON.stringify(delivery));
  await localRpc("anvil_mine",["0x2"]);
  const restoredDelivery=await verifyReadinessDelivery(persisted,approval,paid,fork);
  assert.equal(restoredDelivery.responseHash,delivery.responseHash);
  await assert.rejects(verifyReadinessDelivery({...persisted,report:preview,responseHash:readinessResponseHash(preview)},approval,paid,fork),/before payment/);
  const inventedReport={...delivery.report,account:{...delivery.report.account,usdcBalanceUnits:"1000000"}};
  for(const changed of [
    {...persisted,responseHash:`0x${"01".repeat(32)}`},
    {...persisted,task:{...task,request:"Changed request"}},
    {...persisted,report:{...delivery.report,productionReady:true}},
    {...persisted,report:{...delivery.report,account:{...delivery.report.account,usdcBalanceUnits:"1000000"}}},
    {...persisted,report:inventedReport,responseHash:readinessResponseHash(inventedReport)},
    {...persisted,payment:{...delivery.payment,amountUnits:"12001"}},
    {...persisted,providerOwner:publicTestAttester.address},
    {...persisted,report:{...delivery.report,observation:{...delivery.report.observation,blockNumber:"9999999999"}}},
  ])await assert.rejects(verifyReadinessDelivery(changed,approval,paid,fork));
  assert.throws(()=>planReadinessAssessment(persisted,publicTestAttester.address,85),/Reverify/);
  assert.throws(()=>planReadinessAssessment(restoredDelivery,provider.address,85),/non-provider/);
  assert.throws(()=>planReadinessAssessment(restoredDelivery,publicTestAttester.address,101));
  const evaluationTime=new Date(Math.max(Date.now(),Number(delivery.report.observation.timestamp)*1000+1000));
  const assessmentPlan=planReadinessAssessment(restoredDelivery,publicTestAttester.address,85,evaluationTime);
  assert.equal(assessmentPlan.unsigned,true);
  const reportMessage=assessmentPlan.typedData.message;
  const signedReport=await assessment({...reportMessage,agentId,amount:BigInt(reportMessage.amount),assessedAt:BigInt(reportMessage.assessedAt)},publicTestAttester);
  const actualForkEvidence=await collectMonadEvidence(agentId,{payments:[assessmentPlan.paymentReference],
    assessmentReporters:[publicTestAttester.address],assessments:[signedReport]},fork,evaluationTime);
  assert.ok(actualForkEvidence.evidence.some(item=>item.type==="service_delivery"));
  const deliveredDecision=evaluateMonadPurchase(actualForkEvidence,intent,evaluationTime);
  if(!deliveredDecision.executable)console.log(JSON.stringify({stage:"delivery policy",trust:deliveredDecision.decision.trust,reasons:deliveredDecision.reasons,
    evidence:actualForkEvidence.evidence.map(item=>({type:item.type,positive:item.positive,score:item.score,observedAt:item.observedAt}))}));
  assert.equal(deliveredDecision.executable,true);
  await assert.rejects(simulatePaymentApproval(approval,fork),/nonce changed|already consumed/);
  await assert.rejects(verifyPaymentReceipt(approval,fundingHash,fork));
  await page.getByLabel("Transaction hash from the relayer").fill(paid);await page.getByRole("button",{name:"Verify payment receipt",exact:true}).click();
  await page.getByTestId("confirmed-purchase").waitFor({timeout:45000});
  await page.reload({waitUntil:"networkidle"});await page.getByRole("button",{name:"Verify on Monad",exact:true}).click();
  try {await page.getByRole("status").filter({hasText:"Monad verified its P256 signature"}).waitFor({timeout:45000});}
  catch(error){console.log(JSON.stringify({stage:"reload",browserErrors:errors,rpcErrors,nativeResults,methods:[...methods],status:await page.getByRole("status").allTextContents(),assertions:await page.evaluate(()=>(window as unknown as {assertionDiagnostics:unknown[]}).assertionDiagnostics)}));throw error;}
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
    accountVersion:2,paymentEncoding:"original browser client-data JSON; V2 required prefix and native P256",ownerApprovalPrompts:1,
    existingPasskeySelected:true,wrongPasskeySelectionRejected:true,undeployedAccountSelectionRejected:true,
    requestedAccountCannotUseUnrelatedVerification:true,wrongAccountExportBlocked:true,
    selectionFailureShownSeparately:true,editedAccountInvalidatesSelection:true,explicitSelectionExitRequired:true,
    matchingPasskeyStorageFailureReported:true,
    slowAccountPreparationMs:11000,selectionPromptInFreshUserGesture:true,
    credentialSelectionPersistedAfterReload:true,selectionMovedFunds:false,selectionConsumedPaymentNonce:false,
    universalBrowserPaymentCompatibility:false,
    tamperedTaskRejected:true,identityOnlyBlocked:true,receiptRestoredAfterReload:true,externalTransactionsSent:0,
    readinessDemoRegistrationVerified:true,readinessReportVerified:true,persistedResultRestored:true,prepaymentPreviewRejected:true,
    tamperedResultsRejected:true,signedOperatorAssessmentCollected:true,
    manualTrialReceiptVerified:true,manualTrialBuyerSignatureVerified:true,manualTrialResultVerified:true,
    initialPolicyHistory:"actual localhost trial transfer/result with an explicitly declared test usefulness score",
    serviceDelivery:"local operator readiness result on a disposable fork; no live paid service or real human assessment"}));
}catch(error){
  console.log(JSON.stringify({upstreamErrors,upstreamMethods:[...upstreamMethods]}));throw error;
}finally {
  await browser?.close();anvil.kill("SIGTERM");upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));
}
