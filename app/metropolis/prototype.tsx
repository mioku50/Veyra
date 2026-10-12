"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { encodeAbiParameters, encodePacked, formatUnits, keccak256, toHex } from "viem";
import { AccountSetupError, METROPOLIS_V2_DEPLOYMENT, readAccountSetup, type MetropolisAccountSetup } from "@/lib/monad/account";
import { getMonadReadClient } from "@/lib/monad/erc8004";
import { MONAD_P256_PRECOMPILE } from "@/lib/monad/config";
import { PasskeySelectionError, prepareExistingAccountPasskey, selectExistingAccountPasskey } from "@/lib/monad/passkey-selection";
import { createMetropolisPasskey, METROPOLIS_ORIGIN, passkeyCoordinates, requirePasskeyOrigin,
  signMetropolisDiagnosticChallenge, webAuthnSignedHash, type MetropolisCredential } from "@/lib/monad/passkey";

const STORAGE_KEY = "veyra.metropolis.public-credential.v1";
const PREVIOUS_STORAGE_KEY = "veyra.metropolis.previous-public-credential.v1";
const MetropolisPurchase=dynamic(()=>import("./purchase").then(module=>module.MetropolisPurchase));
export function MetropolisPrototype() {
  const [credential,setCredential] = useState<MetropolisCredential|null>(null);
  const [ready,setReady] = useState(false);
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState("");
  const [verified,setVerified] = useState(false);
  const [setup,setSetup] = useState<MetropolisAccountSetup|null>(null);
  const [setupBusy,setSetupBusy] = useState(false);
  const [setupNotice,setSetupNotice] = useState("");
  const [existingAddress,setExistingAddress] = useState("");
  const [selectionOpen,setSelectionOpen] = useState(false);
  const [selecting,setSelecting] = useState(false);
  const [existingSetup,setExistingSetup] = useState<MetropolisAccountSetup|null>(null);
  const [selectionNotice,setSelectionNotice] = useState("");
  const [selectionFailed,setSelectionFailed] = useState(false);
  const requestedAddress=existingAddress.trim();
  const returningToAccount=!!requestedAddress;
  const activeSetup=setup&&(!returningToAccount||setup.accountAddress.toLowerCase()===requestedAddress.toLowerCase())?setup:null;
  const selectedAccount=returningToAccount&&verified&&!!activeSetup;
  const displayedExistingSetup=activeSetup??existingSetup;
  useEffect(() => {
    try {
      requirePasskeyOrigin(window.location.origin);
      setReady(window.isSecureContext && "PublicKeyCredential" in window && !!navigator.credentials);
      const requested=new URL(window.location.href).searchParams.get("account");
      if(requested){setExistingAddress(requested.slice(0,42));setSelectionOpen(true);}
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as MetropolisCredential;
        if (parsed.origin === window.location.origin && typeof parsed.id === "string") {
          passkeyCoordinates(parsed.publicKey);
          setCredential(parsed);
        }
      }
    } catch { setNotice("Use the canonical Veyra domain to keep your passkey tied to one address."); }
  },[]);

  async function register() {
    if(returningToAccount)return;
    setBusy(true);setNotice("");setVerified(false);
    try {
      const created = await createMetropolisPasskey(window.location.origin);
      localStorage.setItem(STORAGE_KEY,JSON.stringify(created));
      setCredential(created);
      setNotice("Passkey created. Its private key stays with your authenticator.");
    } catch { setNotice("Passkey creation was cancelled or is unavailable in this browser."); }
    finally {setBusy(false);}
  }
  async function verify() {
    if (!credential||returningToAccount) return;
    setBusy(true);setNotice("");setVerified(false);setSetup(null);setSetupNotice("");
    try {
      // A domain-separated diagnostic challenge, never a payment authorization.
      const challenge = keccak256(encodeAbiParameters([{type:"bytes32"},{type:"uint256"},{type:"string"},{type:"uint64"},{type:"bytes32"}],
        [keccak256(toHex("Veyra Metropolis read-only passkey probe v1")),BigInt(10143),window.location.origin,
          BigInt(Math.floor(Date.now()/1000)+120),toHex(crypto.getRandomValues(new Uint8Array(32)))]));
      const assertion = await signMetropolisDiagnosticChallenge(credential,challenge,window.location.origin);
      const {qx,qy} = passkeyCoordinates(credential.publicKey);
      const client = getMonadReadClient();
      if (await client.getChainId() !== 10143) throw new Error("Unexpected chain");
      const result = await client.call({to:MONAD_P256_PRECOMPILE,
        data:encodePacked(["bytes32","bytes32","bytes32","bytes32","bytes32"],
          [webAuthnSignedHash(assertion),assertion.r,assertion.s,qx,qy])});
      if (!result.data || result.data === "0x" || BigInt(result.data) !== BigInt(1)) throw new Error("Signature rejected");
      setVerified(true);
      setNotice("Your browser assertion passed RP, origin and user-verification checks. Monad verified its P256 signature via eth_call.");
    } catch { setNotice("Verification did not complete. The prompt may have been cancelled, the browser format may be unsupported, or the RPC may be unavailable."); }
    finally {setBusy(false);}
  }
  async function prepareAccount() {
    if (!credential || !verified || (returningToAccount&&!selectedAccount)) return;
    setSetupBusy(true);setSetup(null);setSetupNotice("");
    try {
      const result = await readAccountSetup(credential.publicKey,window.location.origin,undefined,undefined,METROPOLIS_V2_DEPLOYMENT.factory);
      if(returningToAccount&&result.accountAddress.toLowerCase()!==requestedAddress.toLowerCase()) {
        throw new AccountSetupError("The saved passkey does not match the requested V2 account. Select its original passkey above.");
      }
      setSetup(result);
      setSetupNotice(result.accountDeployed?"Your V2 account and balance were checked in a finalized Monad block.":"Public V2 account details are ready. Deployment requires a separate approval.");
    } catch (error) {
      setSetupNotice(error instanceof AccountSetupError ? error.message : "Account preparation did not complete. Try again when the Monad RPC is available.");
    } finally {setSetupBusy(false);}
  }
  async function copySetup() {
    if (!activeSetup) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(activeSetup,null,2));
      setSetupNotice(activeSetup.accountDeployed?"Public V2 account details copied. These details do not authorize a payment.":"Public V2 account details copied. Send these details to prepare the deployment.");
    } catch {setSetupNotice("Copy is unavailable here. Open Public setup details below and copy the text manually.");}
  }
  async function selectExisting() {
    if(!existingSetup)return;
    setSelecting(true);setSelectionNotice("");setSelectionFailed(false);setNotice("");setVerified(false);setSetup(null);setSetupNotice("");
    try {
      const selected=await selectExistingAccountPasskey(existingSetup,window.location.origin);
      // Keep the previous public pointer; never persist assertions or private keys.
      try {
        const previous=localStorage.getItem(STORAGE_KEY);
        if(previous&&previous!==JSON.stringify(selected.credential))localStorage.setItem(PREVIOUS_STORAGE_KEY,previous);
        localStorage.setItem(STORAGE_KEY,JSON.stringify(selected.credential));
      } catch {
        throw new PasskeySelectionError("The passkey matched this account, but this browser could not save its public details. Allow site storage and select the key again.");
      }
      setCredential(selected.credential);setSetup(selected.setup);setVerified(true);
      setSelectionNotice("The existing passkey matches this V2 account. Monad verified its signature without a transaction.");
      setSetupNotice("Your existing V2 account and balance were checked in a finalized Monad block.");
    } catch(error) {
      setSelectionFailed(true);
      setSelectionNotice(error instanceof PasskeySelectionError||error instanceof AccountSetupError?error.message:
        "Selection did not complete. Choose the account's original passkey from your password manager and try again. Your saved key was not changed.");
    } finally {setSelecting(false);}
  }
  async function checkExisting() {
    setSelecting(true);setSelectionNotice("");setSelectionFailed(false);setNotice("");setExistingSetup(null);setVerified(false);setSetup(null);setSetupNotice("");
    try {
      setExistingSetup(await prepareExistingAccountPasskey(existingAddress.trim(),window.location.origin));
      setSelectionNotice("Existing V2 account checked. Access is not confirmed yet. Select its original passkey to use it.");
    } catch(error) {
      setSelectionFailed(true);
      setSelectionNotice(error instanceof PasskeySelectionError||error instanceof AccountSetupError?error.message:
        "The existing account could not be checked. Try again when the Monad RPC is available.");
    } finally {setSelecting(false);}
  }
  function changeExistingAddress(address:string) {
    setExistingAddress(address);setExistingSetup(null);setSelectionNotice("");setSelectionFailed(false);
    setNotice("");setVerified(false);setSetup(null);setSetupNotice("");
  }
  function useSavedPasskey() {
    changeExistingAddress("");
    const url=new URL(window.location.href);url.searchParams.delete("account");
    window.history.replaceState(null,"",url);
  }

  return <main className="mx-auto max-w-3xl px-5 py-10 sm:py-16">
    <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
      <Link href="/" className="font-semibold">Veyra</Link>
      <span className="rounded-full border border-violet-400/40 px-3 py-1 text-sm text-violet-300">Metropolis · Monad Testnet</span>
    </div>
    <p className="text-sm uppercase tracking-widest text-violet-300">Human-approved Testnet prototype</p>
    <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Veyra checks the spend.<br />You hold the final say.</h1>
    <p className="mt-5 text-lg text-muted-foreground">The Monad integration pairs Veyra&apos;s trust policy with an owner&apos;s passkey approval for an exact USDC payment.</p>
    <section className="mt-8 rounded-2xl border border-white/15 bg-white/5 p-5 sm:p-7" aria-labelledby="passkey-title">
      <h2 id="passkey-title" className="text-xl font-semibold">{returningToAccount?"Return to your existing V2 account":"Test your passkey on Monad"}</h2>
      <p className="mt-3 text-muted-foreground">{returningToAccount?"Check the requested account, then select its original passkey. Access is confirmed only when that key's signature matches the account on Monad.":"Create a browser passkey and verify a diagnostic signature using Monad's native P256 verifier."} This check sends no transaction and authorizes no payment.</p>
      {!returningToAccount?<div className="mt-6 flex flex-wrap gap-3">
        {!credential ? <button onClick={register} disabled={!ready||busy||selecting} className="rounded-xl bg-violet-500 px-5 py-3 font-semibold disabled:opacity-50">{busy?"Creating…":"Create test passkey"}</button>
          : <button onClick={verify} disabled={!ready||busy||setupBusy||selecting} className="rounded-xl bg-violet-500 px-5 py-3 font-semibold disabled:opacity-50">{busy?"Verifying…":"Verify on Monad"}</button>}
      </div>:null}
      {!returningToAccount&&!credential?<p className="mt-3 text-sm text-muted-foreground">Already have a funded account? Use its existing passkey below. A new passkey creates a separate account and cannot recover an earlier account.</p>:null}
      <details className="mt-5 border-t border-white/15 pt-4" open={selectionOpen} onToggle={event=>setSelectionOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer py-2 text-sm font-semibold text-violet-300">Use an existing passkey</summary>
        <p className="mt-2 text-sm text-muted-foreground">Enter your deployed V2 account address, then choose the original passkey in your device&apos;s password manager. This selects the account you already have.</p>
        <form className="mt-4 space-y-3" onSubmit={event=>{event.preventDefault();void (existingSetup?selectExisting():checkExisting());}}>
          <label className="block text-sm" htmlFor="existing-account-address">Existing V2 account address</label>
          <input id="existing-account-address" value={existingAddress} onChange={event=>changeExistingAddress(event.target.value)}
            maxLength={42} required autoComplete="off" spellCheck={false} disabled={!ready||busy||setupBusy||selecting}
            placeholder="0x…" className="w-full rounded-lg border border-white/20 bg-black/20 p-3 font-mono text-sm" />
          <button type="submit" disabled={!ready||busy||setupBusy||selecting||!existingAddress.trim()}
            className="rounded-xl bg-violet-500 px-5 py-3 font-semibold disabled:opacity-50">{existingSetup?(selecting?"Checking your passkey…":"Select existing passkey"):(selecting?"Checking account…":"Check existing account")}</button>
        </form>
      </details>
      {returningToAccount?<div className="mt-5 space-y-3 rounded-xl border border-violet-400/30 p-4">
        <p className="text-sm font-semibold">{selectedAccount?"Selected V2 account":"Requested V2 account"}</p>
        <p className="break-all font-mono text-sm" data-testid="requested-account-address">{existingSetup?.accountAddress??requestedAddress}</p>
        {displayedExistingSetup?<p className="text-sm text-muted-foreground">{formatUnits(BigInt(displayedExistingSetup.usdcBalanceUnits),6)} test USDC at finalized block {displayedExistingSetup.observedBlock}. {selectedAccount?"Access confirmed by your passkey.":"Balance checked; passkey selection still required."}</p>:null}
        <p className={`text-sm ${selectionFailed?"text-amber-300":selectedAccount?"text-emerald-300":"text-muted-foreground"}`} role={selectionFailed?"alert":"status"} aria-live="polite">{selectionNotice||"First check this account, then select its original passkey."}</p>
        {selectionFailed?<p className="text-sm text-muted-foreground">No account switch was completed. Your saved key is unchanged. Select the original key again; checking a different saved key will not open this account.</p>:null}
        {selectionFailed&&selectionNotice.includes("does not belong to this account")?<p className="text-sm text-muted-foreground">If your password manager offers only one Veyra key, an earlier registration may have replaced the original. Check for the original key on another device or in your password manager&apos;s deleted items. This prototype cannot recover or replace a lost account key.</p>:null}
        {!selectedAccount&&credential?<button onClick={useSavedPasskey} disabled={!ready||busy||setupBusy||selecting} className="text-sm text-muted-foreground underline disabled:opacity-50">Cancel account selection and use the saved passkey</button>:null}
      </div>:<p className={`mt-4 text-sm ${verified?"text-emerald-300":"text-muted-foreground"}`} role="status" aria-live="polite">{notice || "Face ID, Touch ID or your device's user-verification method will confirm the request."}</p>}
      {credential&&!returningToAccount ? <p className="mt-4 text-xs text-muted-foreground">Public credential metadata is saved in this browser. Prepare your account below to check its deployment and balance.</p>:null}
      {!ready ? <a className="mt-4 inline-block break-all text-sm text-cyan-300 underline" href={`${METROPOLIS_ORIGIN}/metropolis`}>Open the canonical Veyra address</a>:null}
    </section>
    {credential&&(!returningToAccount||selectedAccount) ? <section className="mt-6 rounded-2xl border border-white/15 p-5 sm:p-7" aria-labelledby="account-title">
      <h2 id="account-title" className="text-xl font-semibold">Your personal V2 account</h2>
      <p className="mt-3 text-sm text-muted-foreground">Check the account for the passkey saved in this browser. Veyra verifies the V2 factory, account configuration and Testnet USDC balance.</p>
      <p className="mt-2 text-xs text-muted-foreground">V2 has its own address. Funds and historical receipts in a V1 account stay with that account.</p>
      <button onClick={prepareAccount} disabled={!ready||!verified||busy||setupBusy||selecting} className="mt-5 rounded-xl border border-violet-400/40 px-5 py-3 font-semibold disabled:opacity-50">{setupBusy?"Checking Monad…":"Prepare account"}</button>
      {!verified ? <p className="mt-3 text-sm text-muted-foreground">Verify your saved passkey above first.</p>:null}
      <p className="mt-4 text-sm text-muted-foreground" role="status" aria-live="polite">{setupNotice}</p>
      {activeSetup ? <div className="mt-5 space-y-4">
        <dl className="space-y-3 text-sm">
          <div><dt className="text-muted-foreground">Account address</dt><dd className="mt-1 break-all font-mono" data-testid="account-address">{activeSetup.accountAddress}</dd></div>
          <div><dt className="text-muted-foreground">Status at finalized block {activeSetup.observedBlock}</dt><dd>{activeSetup.accountDeployed?"Deployed":"Not deployed"}</dd></div>
          <div><dt className="text-muted-foreground">Testnet USDC balance</dt><dd>{formatUnits(BigInt(activeSetup.usdcBalanceUnits),6)} USDC</dd></div>
        </dl>
        <p className="text-sm text-muted-foreground">The setup details contain your public key and account configuration. Your private passkey stays with your authenticator.</p>
        <button onClick={copySetup} className="rounded-xl bg-violet-500 px-5 py-3 font-semibold">Copy public account details</button>
        <details className="text-sm"><summary className="cursor-pointer py-2 text-violet-300">Public setup details</summary>
          <textarea aria-label="Public account setup JSON" readOnly value={JSON.stringify(activeSetup,null,2)} onFocus={event=>event.currentTarget.select()} className="mt-3 h-64 w-full rounded-lg border border-white/15 bg-black/20 p-3 font-mono text-xs" />
        </details>
      </div>:null}
    </section>:null}
    {credential&&activeSetup?.accountDeployed?<MetropolisPurchase key={activeSetup.accountAddress} credential={credential} factory={activeSetup.factory} enabled={ready&&verified&&!busy&&!setupBusy&&!selecting} />:null}
    <section className="mt-6 rounded-2xl border border-white/15 p-5 sm:p-7">
      <h2 className="text-xl font-semibold">Integration status</h2>
      <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
        <li>TrustGate and CREATE2 factory: deployed on Monad Testnet; source verification matched.</li>
        <li><a className="break-all text-cyan-300 underline" href={`https://testnet.monadscan.com/address/${METROPOLIS_V2_DEPLOYMENT.factory}`} target="_blank" rel="noreferrer">View the deployed V2 factory</a></li>
        <li>V2 passkey payment: tested on a disposable Monad fork with a real browser assertion.</li>
        <li>Native P256: verified through live RPC and a pinned Monad fork.</li>
        <li>Personal account: deployment and funding are shown above from finalized reads.</li>
        <li>Purchase approval: exact task and payment review, passkey signature and contract simulation.</li>
        <li>Actual payment, service delivery and feedback: pending until separately verified.</li>
      </ul>
      <p className="mt-5 text-sm text-muted-foreground">Payment success and delivery success will be shown separately. Demonstration agents and their evidence will be identified explicitly.</p>
    </section>
  </main>;
}
