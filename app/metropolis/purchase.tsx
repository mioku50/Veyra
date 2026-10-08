"use client";

import { useEffect,useState } from "react";
import { formatUnits,type Hex } from "viem";
import { PaymentError,parsePaymentApproval,simulatePaymentApproval,verifyPurchaseSignatures,verifyPurchaseState,type PaymentApproval,type SignedPurchase } from "@/lib/monad/payment";
import { verifyPaymentReceipt } from "@/lib/monad/payment-receipt";
import { signMetropolisChallenge,type MetropolisCredential } from "@/lib/monad/passkey";

export function MetropolisPurchase({credential,enabled}:{credential:MetropolisCredential;enabled:boolean}) {
  const [input,setInput]=useState("");
  const [quote,setQuote]=useState<SignedPurchase|null>(null);
  const [approval,setApproval]=useState<PaymentApproval|null>(null);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState("");
  const [now,setNow]=useState(0);
  const [hash,setHash]=useState("");
  const [receipt,setReceipt]=useState<Awaited<ReturnType<typeof verifyPaymentReceipt>>|null>(null);
  const [archived,setArchived]=useState(false);
  useEffect(()=>{
    if(!quote)return;
    const update=()=>setNow(Math.floor(Date.now()/1000));update();
    const timer=setInterval(update,1000);return()=>clearInterval(timer);
  },[quote]);
  const expired=!!quote&&now>=Number(quote.deadline);
  function errorNotice(error:unknown) {
    setNotice(error instanceof PaymentError?error.message:"The check did not complete. Check the proposal's expiry and Monad connection, then try again.");
  }
  async function checkProposal() {
    setBusy(true);setQuote(null);setApproval(null);setReceipt(null);setHash("");setNotice("");setArchived(false);
    try {
      if(input.length>65536)throw new PaymentError("The proposal is too large.");
      let value:unknown;try{value=JSON.parse(input);}catch{throw new PaymentError("Paste a valid signed purchase proposal.");}
      if(value&&typeof value==="object"&&"kind" in value&&value.kind==="veyra.metropolis.payment-approval") {
        const saved=parsePaymentApproval(value);
        const state=await verifyPurchaseSignatures(saved.quote);
        if(state.quote.publicKey!==credential.publicKey.toLowerCase())throw new PaymentError("This approval belongs to a different saved passkey.");
        setArchived(true);setApproval(saved);
        setNotice("Saved approval loaded for receipt verification. Enter its transaction hash below.");return;
      }
      const state=await verifyPurchaseState(value,credential.publicKey);
      setQuote(state.quote);setNotice("Veyra's signatures and the current onchain payment details passed the checks.");
    }catch(error){errorNotice(error);}finally{setBusy(false);}
  }
  async function approve() {
    if(!quote)return;
    setBusy(true);setApproval(null);setReceipt(null);setNotice("");
    try {
      const state=await verifyPurchaseState(quote,credential.publicKey);
      const assertion=await signMetropolisChallenge(credential,state.challenge,window.location.origin);
      const value:PaymentApproval={kind:"veyra.metropolis.payment-approval",version:1,quote:state.quote,
        assertion:{...assertion,challengeIndex:assertion.challengeIndex.toString(),typeIndex:assertion.typeIndex.toString()}};
      const simulated=await simulatePaymentApproval(value);
      setApproval(simulated.approval);
      setNotice("Your approval passed a full contract simulation. No transaction has been sent. Copy it to the relayer before it expires.");
    }catch(error){errorNotice(error);}finally{setBusy(false);}
  }
  async function copyApproval() {
    if(!approval||expired)return;
    try {await navigator.clipboard.writeText(JSON.stringify(approval,null,2));setNotice("Payment approval copied. It authorizes this exact payment once, before the displayed expiry.");}
    catch {setNotice("Copy is unavailable. Open Approved payment details and copy the text manually.");}
  }
  async function checkReceipt() {
    if(!approval)return;
    setBusy(true);setReceipt(null);setNotice("");
    try {
      const result=await verifyPaymentReceipt(approval,hash.trim() as Hex);
      setReceipt(result);setQuote(approval.quote);setNotice("The payment is confirmed in a finalized block. The service result has not been assessed yet.");
    }catch(error){errorNotice(error);}finally{setBusy(false);}
  }
  return <section className="mt-6 rounded-2xl border border-white/15 p-5 sm:p-7" aria-labelledby="purchase-title">
    <h2 id="purchase-title" className="text-xl font-semibold">Review an exact purchase</h2>
    <p className="mt-3 text-sm text-muted-foreground">Review the task, provider and price. Your passkey approval lets a relayer execute this payment once. A transfer does not guarantee delivery.</p>
    <label htmlFor="purchase-proposal" className="mt-5 block text-sm">Signed purchase proposal or saved payment approval</label>
    <textarea id="purchase-proposal" value={input} disabled={busy} maxLength={65536} spellCheck={false}
      onChange={event=>{setInput(event.target.value);setQuote(null);setApproval(null);setReceipt(null);setNotice("");setArchived(false);}}
      className="mt-2 h-36 w-full rounded-lg border border-white/15 bg-black/20 p-3 font-mono text-xs" />
    <button onClick={checkProposal} disabled={!enabled||busy||!input.trim()} className="mt-3 rounded-xl border border-violet-400/40 px-5 py-3 font-semibold disabled:opacity-50">{busy?"Checking…":"Check proposal"}</button>
    <p role="status" aria-live="polite" className="mt-4 text-sm text-muted-foreground">{notice}</p>
    {quote?<div className="mt-5 space-y-4" data-testid="validated-purchase">
      <h3 className="font-semibold">{quote.task.request}</h3>
      <p className="text-sm text-muted-foreground">Expected result: {quote.task.deliverable}</p>
      <dl className="space-y-3 text-sm">
        <div><dt className="text-muted-foreground">Provider</dt><dd>ERC-8004 #{quote.provider.agentId}{quote.provider.demonstration?" · Veyra demonstration agent":""}</dd></div>
        <div><dt className="text-muted-foreground">Recipient</dt><dd className="break-all font-mono">{quote.provider.payee}</dd></div>
        <div><dt className="text-muted-foreground">Exact payment</dt><dd className="font-semibold">{formatUnits(BigInt(quote.clearance.requestedAmount),6)} Testnet USDC</dd></div>
        <div><dt className="text-muted-foreground">Budget for this task</dt><dd>{quote.budgetUsdc} Testnet USDC · policy limit {formatUnits(BigInt(quote.clearance.maxAmount),6)} USDC</dd></div>
        <div><dt className="text-muted-foreground">Veyra policy</dt><dd>{quote.policy.decision} · score {quote.policy.score} · evidence coverage {Math.round(quote.policy.coverage*100)}%</dd></div>
        <div><dt className="text-muted-foreground">Network and account</dt><dd className="break-all">Monad Testnet (10143) · {quote.accountAddress}</dd></div>
        <div><dt className="text-muted-foreground">Approval expires</dt><dd>{new Date(Number(quote.deadline)*1000).toLocaleString()}{expired?" · Expired":""}</dd></div>
      </dl>
      {quote.policy.reasons.length?<ul className="list-inside list-disc text-sm">{quote.policy.reasons.map((reason,index)=><li key={`${index}:${reason}`}>{reason}</li>)}</ul>:null}
      <details className="text-sm"><summary className="cursor-pointer py-2 text-violet-300">Evidence and limitations</summary>
        <ul className="mt-2 list-inside list-disc space-y-2">{quote.policy.disclosures.map((item,index)=><li key={`${index}:${item}`}>{item}</li>)}</ul>
      </details>
      <button onClick={approve} disabled={!enabled||busy||expired||!!approval||!!receipt} className="rounded-xl bg-violet-500 px-5 py-3 font-semibold disabled:opacity-50">Approve {formatUnits(BigInt(quote.clearance.requestedAmount),6)} USDC with passkey</button>
      {approval?<div className="space-y-3">
        <p className="text-sm">The relayer pays MON gas. Your account pays only the exact USDC amount above.</p>
        <button onClick={copyApproval} disabled={busy||expired||!!receipt||archived} className="rounded-xl border border-violet-400/40 px-5 py-3 font-semibold disabled:opacity-50">Copy approved payment</button>
        <details className="text-sm"><summary className="cursor-pointer py-2 text-violet-300">Approved payment details</summary>
          <textarea aria-label="Approved payment JSON" readOnly value={JSON.stringify(approval,null,2)} onFocus={event=>event.currentTarget.select()} className="mt-2 h-48 w-full rounded-lg border border-white/15 bg-black/20 p-3 font-mono text-xs" />
        </details>
        <label htmlFor="payment-hash" className="block text-sm">Transaction hash from the relayer</label>
        <input id="payment-hash" value={hash} disabled={busy} onChange={event=>{setHash(event.target.value);setReceipt(null);}} maxLength={66} spellCheck={false} className="w-full rounded-lg border border-white/15 bg-black/20 p-3 font-mono text-xs" />
        <button onClick={checkReceipt} disabled={busy||!hash.trim()} className="rounded-xl border border-violet-400/40 px-5 py-3 font-semibold disabled:opacity-50">Verify payment receipt</button>
      </div>:null}
      {receipt?<div className="rounded-lg border border-emerald-400/30 p-4 text-sm" data-testid="confirmed-purchase">
        <p className="font-semibold text-emerald-300">Payment confirmed: {receipt.amountUsdc} USDC</p>
        <p className="mt-2">Service delivery: not assessed</p>
        <a href={`https://testnet.monadscan.com/tx/${receipt.transactionHash}`} target="_blank" rel="noreferrer" className="mt-2 inline-block text-cyan-300 underline">View transaction</a>
      </div>:null}
    </div>:null}
    {archived&&approval&&!quote?<div className="mt-4 space-y-3">
      <label htmlFor="payment-hash" className="block text-sm">Transaction hash from the relayer</label>
      <input id="payment-hash" value={hash} disabled={busy} onChange={event=>setHash(event.target.value)} maxLength={66} spellCheck={false} className="w-full rounded-lg border border-white/15 bg-black/20 p-3 font-mono text-xs" />
      <button onClick={checkReceipt} disabled={busy||!hash.trim()} className="rounded-xl border border-violet-400/40 px-5 py-3 font-semibold disabled:opacity-50">Verify payment receipt</button>
    </div>:null}
  </section>;
}
