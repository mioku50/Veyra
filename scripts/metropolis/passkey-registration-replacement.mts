import assert from "node:assert/strict";
import { chromium } from "playwright";
import { keccak256, toHex } from "viem";

// Reproduce the old registration options on an isolated virtual authenticator.
// No owner keys, live site, blockchain, or password-manager store is accessed.
const browser=await chromium.launch({headless:true});
try {
  const context=await browser.newContext();
  await context.route("https://legacy-registration.test/**",route=>route.fulfill({
    contentType:"text/html",body:'<button id="create">Create</button>',
  }));
  const page=await context.newPage();
  const cdp=await context.newCDPSession(page);await cdp.send("WebAuthn.enable");
  const {authenticatorId}=await cdp.send("WebAuthn.addVirtualAuthenticator",{options:{
    protocol:"ctap2",transport:"internal",hasResidentKey:true,hasUserVerification:true,
    isUserVerified:true,automaticPresenceSimulation:true,
  }});
  await page.goto("https://legacy-registration.test");
  // The installed viem/Ox default was keccak256(name) when user.id was omitted.
  const handle=Array.from(Buffer.from(keccak256(toHex("Veyra Metropolis Testnet")).slice(2),"hex"));
  await page.evaluate(userHandle=>{
    const state=window as unknown as {publicIds:string[];registrationError?:string};
    state.publicIds=[];
    document.querySelector<HTMLButtonElement>("#create")!.onclick=async()=>{
      try {
        const raw=await navigator.credentials.create({publicKey:{
          rp:{id:location.hostname,name:"Veyra Metropolis"},
          user:{id:Uint8Array.from(userHandle),name:"Veyra Metropolis Testnet",displayName:"Veyra Metropolis Testnet"},
          challenge:crypto.getRandomValues(new Uint8Array(32)),pubKeyCredParams:[{type:"public-key",alg:-7}],
          authenticatorSelection:{authenticatorAttachment:"platform",residentKey:"required",requireResidentKey:true,userVerification:"required"},
        }}) as PublicKeyCredential;
        state.publicIds.push(raw.id);
      }catch(error){state.registrationError=error instanceof Error?error.message:String(error);}
    };
  },handle);
  for(const count of [1,2]) {
    await page.click("#create");
    await page.waitForFunction(expected=>{
      const state=window as unknown as {publicIds:string[];registrationError?:string};
      if(state.registrationError)throw new Error(state.registrationError);
      return state.publicIds.length===expected;
    },count);
  }
  const ids=await page.evaluate(()=>(window as unknown as {publicIds:string[]}).publicIds);
  // CDP also returns private material; retain only public IDs, never log it.
  const residentIds=(await cdp.send("WebAuthn.getCredentials",{authenticatorId})).credentials
    .map(item=>Buffer.from(item.credentialId,"base64").toString("base64url"));
  assert.equal(residentIds.length,1);assert.equal(residentIds[0],ids[1]);
  assert.equal(residentIds.includes(ids[0]),false);
  console.log(JSON.stringify({result:"PASS",scope:"isolated Chromium virtual authenticator",
    legacyNameDerivedHandleReused:true,registrations:2,remainingResidentCredentials:residentIds.length,
    firstCredentialReplaced:true,ownerICloudStateEstablished:false,privateMaterialPersisted:false,externalTransactionsSent:0}));
}finally {await browser.close();}
