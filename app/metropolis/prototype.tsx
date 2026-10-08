"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { encodeAbiParameters, encodePacked, keccak256, toHex } from "viem";
import { getMonadReadClient } from "@/lib/monad/erc8004";
import { MONAD_P256_PRECOMPILE } from "@/lib/monad/config";
import { createMetropolisPasskey, METROPOLIS_ORIGIN, passkeyCoordinates, requirePasskeyOrigin,
  signMetropolisChallenge, webAuthnSignedHash, type MetropolisCredential } from "@/lib/monad/passkey";

const STORAGE_KEY = "veyra.metropolis.public-credential.v1";
export function MetropolisPrototype() {
  const [credential,setCredential] = useState<MetropolisCredential|null>(null);
  const [ready,setReady] = useState(false);
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState("");
  const [verified,setVerified] = useState(false);
  useEffect(() => {
    try {
      requirePasskeyOrigin(window.location.origin);
      setReady(window.isSecureContext && "PublicKeyCredential" in window && !!navigator.credentials);
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
    if (!credential) return;
    setBusy(true);setNotice("");setVerified(false);
    try {
      // A domain-separated diagnostic challenge, never a payment authorization.
      const challenge = keccak256(encodeAbiParameters([{type:"bytes32"},{type:"uint256"},{type:"string"},{type:"uint64"},{type:"bytes32"}],
        [keccak256(toHex("Veyra Metropolis read-only passkey probe v1")),BigInt(10143),window.location.origin,
          BigInt(Math.floor(Date.now()/1000)+120),toHex(crypto.getRandomValues(new Uint8Array(32)))]));
      const assertion = await signMetropolisChallenge(credential,challenge,window.location.origin);
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

  return <main className="mx-auto max-w-3xl px-5 py-10 sm:py-16">
    <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
      <Link href="/" className="font-semibold">Veyra</Link>
      <span className="rounded-full border border-violet-400/40 px-3 py-1 text-sm text-violet-300">Metropolis · Monad Testnet</span>
    </div>
    <p className="text-sm uppercase tracking-widest text-violet-300">Read-only prototype</p>
    <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Veyra checks the spend.<br />You hold the final say.</h1>
    <p className="mt-5 text-lg text-muted-foreground">The Monad integration pairs Veyra&apos;s trust policy with an owner&apos;s passkey approval for an exact USDC payment.</p>
    <section className="mt-8 rounded-2xl border border-white/15 bg-white/5 p-5 sm:p-7" aria-labelledby="passkey-title">
      <h2 id="passkey-title" className="text-xl font-semibold">Test your passkey on Monad</h2>
      <p className="mt-3 text-muted-foreground">Create a browser passkey and verify a diagnostic signature using Monad&apos;s native P256 verifier. This check sends no transaction and authorizes no payment.</p>
      <div className="mt-6 flex flex-wrap gap-3">
        {!credential ? <button onClick={register} disabled={!ready||busy} className="rounded-xl bg-violet-500 px-5 py-3 font-semibold disabled:opacity-50">{busy?"Creating…":"Create test passkey"}</button>
          : <button onClick={verify} disabled={!ready||busy} className="rounded-xl bg-violet-500 px-5 py-3 font-semibold disabled:opacity-50">{busy?"Verifying…":"Verify on Monad"}</button>}
      </div>
      <p className={`mt-4 text-sm ${verified?"text-emerald-300":"text-muted-foreground"}`} role="status" aria-live="polite">{notice || "Face ID, Touch ID or your device's user-verification method will confirm the request."}</p>
      {credential ? <p className="mt-4 text-xs text-muted-foreground">Public credential metadata is saved in this browser. Account deployment and funding have not happened.</p>:null}
      {!ready ? <a className="mt-4 inline-block break-all text-sm text-cyan-300 underline" href={`${METROPOLIS_ORIGIN}/metropolis`}>Open the canonical Veyra address</a>:null}
    </section>
    <section className="mt-6 rounded-2xl border border-white/15 p-5 sm:p-7">
      <h2 className="text-xl font-semibold">Integration status</h2>
      <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
        <li>Account and CREATE2 factory: implemented and tested locally.</li>
        <li>Native P256: verified through live RPC and a pinned Monad fork.</li>
        <li>Deployed account, actual payment, service delivery and feedback: pending.</li>
      </ul>
      <p className="mt-5 text-sm text-muted-foreground">Payment success and delivery success will be shown separately. Demonstration agents and their evidence will be identified explicitly.</p>
    </section>
  </main>;
}
