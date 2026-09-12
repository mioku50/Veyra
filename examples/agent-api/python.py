#!/usr/bin/env python3
# Copyright 2026 Veyra
# SPDX-License-Identifier: Apache-2.0
"""
Veyra Agent API v1 Python Client Example

Usage:
  python3 examples/agent-api/python.py <BASE_URL> <API_KEY> [REPOSITORY]

Example:
  python3 examples/agent-api/python.py https://agent-commerce.vercel.app aac_live_your_key_here circlefin/agent-commerce
"""

import json
import os
import sys
import time
import uuid
import urllib.request
import urllib.error

# Standard Veyra workflow / finalizer pricing constant: 0.0020 USDC
DEFAULT_FINALIZER_PRICE_USDC = "0.0020"


class MachineApiClient:
    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip('/')
        self.api_key = api_key

    def _headers(self, idempotency_key: str = None) -> dict:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "Arc-Agent-Commerce-Python-Client/1.0",
        }
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return headers

    def _http_request(self, method: str, path: str, payload: dict = None, idempotency_key: str = None) -> dict:
        url = f"{self.base_url}{path}"
        headers = self._headers(idempotency_key)
        data = json.dumps(payload).encode('utf-8') if payload else None

        req = urllib.request.Request(url, data=data, headers=headers, method=method)

        try:
            with urllib.request.urlopen(req) as response:
                body = response.read().decode('utf-8')
                return json.loads(body)
        except urllib.error.HTTPError as e:
            err_body = e.read().decode('utf-8')
            try:
                err_json = json.loads(err_body)
                msg = err_json.get('error', {}).get('message', e.reason)
                code = err_json.get('error', {}).get('code', 'http_error')
                raise RuntimeError(f"API Error [{e.code} - {code}]: {msg}")
            except json.JSONDecodeError:
                raise RuntimeError(f"HTTP Error {e.code}: {e.reason}")
        except urllib.error.URLError as e:
            raise RuntimeError(f"Network Connection Error: {e.reason}")

    def list_workflows(self) -> list:
        """1. Discover available workflows"""
        print("\n🔍 Step 1: Querying available Veyra Agent API workflows...")
        res = self._http_request("GET", "/api/agent/v1/workflows")
        workflows = res.get("workflows", [])
        print(f"✅ Discovered {len(workflows)} workflow(s):")
        for wf in workflows:
            print(f"   - {wf.get('name')} ({wf.get('id')}): {wf.get('estimatedUsdc')} USDC est.")
        return workflows

    def create_quote(self, workflow: str, repository: str, idempotency_key: str = None) -> dict:
        """2. Request an immutable quote with Idempotency-Key"""
        id_key = idempotency_key or f"idemp_{uuid.uuid4()}"
        print(f"\n📜 Step 2: Creating quote for workflow '{workflow}' on '{repository}'...")
        print(f"   - Idempotency-Key: {id_key}")

        payload = {
            "workflow": workflow,
            "repository": repository,
        }

        quote = self._http_request("POST", "/api/agent/v1/quotes", payload=payload, idempotency_key=id_key)
        print(f"✅ Quote Created: {quote.get('quoteId')}")
        print(f"   - Total Cost: {quote.get('totalUsdc')} USDC")
        print(f"   - Payment Mode: {'Sponsored Quota' if quote.get('sponsored') else 'Paid x402 Transaction'}")
        print(f"   - Expires At: {quote.get('expiresAt')}")
        return quote

    def launch_run(self, quote_id: str, payment_tx_hash: str = None, idempotency_key: str = None) -> dict:
        """3. Launch workflow execution"""
        id_key = idempotency_key or f"idemp_{uuid.uuid4()}"
        print(f"\n🚀 Step 3: Launching workflow run for quote '{quote_id}'...")

        payload = {"quoteId": quote_id}
        if payment_tx_hash:
            payload["paymentAuthorization"] = {
                "type": "arc_transaction",
                "payload": payment_tx_hash,
            }

        run = self._http_request("POST", "/api/agent/v1/runs", payload=payload, idempotency_key=id_key)
        print(f"✅ Run Queued! Run ID: {run.get('runId')} (Initial status: {run.get('status')})")
        return run

    def poll_until_completion(self, run_id: str, initial_poll_ms: int = 2000, max_attempts: int = 60) -> dict:
        """4. Poll execution status until completed or failed"""
        print(f"\n⏳ Step 4: Polling run execution status for '{run_id}'...")
        poll_interval_sec = initial_poll_ms / 1000.0

        for attempt in range(1, max_attempts + 1):
            status_data = self._http_request("GET", f"/api/agent/v1/runs/{run_id}")
            status = status_data.get("status")
            progress = status_data.get("progress", 0.0)
            stage = status_data.get("stage", status)
            pct = int(progress * 100)

            print(f"   [Attempt {attempt}] Status: {status} | Stage: {stage} ({pct}%)")

            if status in ("completed", "completed_with_warnings", "failed"):
                print(f"✅ Execution Finished with status: {status}")
                return status_data

            poll_ms = status_data.get("pollAfterMs", initial_poll_ms)
            poll_interval_sec = max(poll_ms / 1000.0, 1.0)
            time.sleep(poll_interval_sec)

        raise RuntimeError(f"Polling timed out after {max_attempts} attempts for run '{run_id}'.")

    def get_report(self, report_id: str) -> dict:
        """5. Retrieve structured final report & Arc proofs"""
        print(f"\n📊 Step 5: Retrieving structured report '{report_id}'...")
        report = self._http_request("GET", f"/api/agent/v1/reports/{report_id}")
        print("✅ Report Retrieved Successfully!")
        print(f"   - Executive Summary: {report.get('executiveSummary')}")
        print(f"   - Primary Language: {report.get('technology', {}).get('primaryLanguage')}")
        print(f"   - Strengths Count: {len(report.get('strengths', []))}")
        print(f"   - Risks Count: {len(report.get('risks', []))}")

        verification = report.get("verification", {})
        print(f"   - Verification Status: {verification.get('status')}")
        proofs = verification.get("proofs", [])
        print(f"   - Arc Proofs Recorded: {len(proofs)} on {verification.get('network')}")

        if proofs:
            print("\n🔗 Step 6: Arc Proof Trail:")
            for proof in proofs:
                tx = proof.get("txHash")
                p_status = proof.get("status")
                explorer = proof.get("explorerUrl")
                print(f"   - Tx: {tx} ({p_status})")
                if explorer:
                    print(f"     Explorer: {explorer}")

        return report


def main():
    args = sys.argv[1:]
    base_url = args[0] if len(args) > 0 else os.environ.get("API_BASE_URL", "http://localhost:3000")
    api_key = args[1] if len(args) > 1 else os.environ.get("API_KEY", "aac_live_demo_key")
    repo = args[2] if len(args) > 2 else "circlefin/agent-commerce"

    print("=================================================")
    print("Veyra Agent API v1 Python Client")
    print("=================================================")
    print(f"Target Host: {base_url}")
    print(f"Target Repo: {repo}")

    client = MachineApiClient(base_url, api_key)

    try:
        # 1. Discover
        client.list_workflows()

        # 2. Quote
        quote = client.create_quote("github_due_diligence", repo)

        # 3. Launch handling (Sponsored vs Paid Arc Transaction)
        payment_tx_hash = None
        if not quote.get("sponsored"):
            payment_tx_hash = os.environ.get("PAYMENT_TX_HASH")
            if not payment_tx_hash:
                print("\n⚠️ Paid quote requires an Arc USDC transaction.")
                print("   Provide PAYMENT_TX_HASH environment variable and run again.")
                return

        run = client.launch_run(quote.get("quoteId"), payment_tx_hash=payment_tx_hash)

        # 4. Poll
        final_status = client.poll_until_completion(run.get("runId"))

        # 5. Retrieve Report & Verify
        report_id = final_status.get("reportId")
        if report_id:
            client.get_report(report_id)

        print("\n🎉 Complete Veyra Agent API flow completed successfully!")
    except Exception as err:
        print(f"\n❌ Veyra Agent API flow failed: {err}")
        sys.exit(1)


if __name__ == "__main__":
    main()
