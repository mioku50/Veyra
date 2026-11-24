/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGuardedFetch, guardedFetch, VeyraBlockedError } from "../sdk/x402-guard/src/index.ts";

const resource = "https://seller.example/v1/search";
const verdictUrl = "https://veyra.example/api/x402/v1/verdict";

test("guardedFetch passes non-402 responses through without calling Veyra", async () => {
  let verdictCalls = 0;
  const res = await guardedFetch(
    resource,
    { method: "GET" },
    {
      budgetUsdc: 0.25,
      verdictUrl,
      fetchImpl: async (url) => {
        if (String(url) === verdictUrl) verdictCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
  );
  assert.equal(res.status, 200);
  assert.equal(verdictCalls, 0);
});

test("guardedFetch returns untouched 402 when preflight passes and forwards no upstream auth/payment headers", async () => {
  let capturedVerdictHeaders: Headers | undefined;
  let capturedVerdictBody: Record<string, unknown> | undefined;
  const original402 = new Response("payment required", {
    status: 402,
    headers: { "PAYMENT-REQUIRED": "abc123" },
  });

  const guard = createGuardedFetch({
    budgetUsdc: 0.25,
    verdictUrl,
    verdictHeaders: { "Sec-GPC": "1" },
    fetchImpl: async (url, init) => {
      if (String(url) === verdictUrl) {
        capturedVerdictHeaders = new Headers(init?.headers);
        capturedVerdictBody = JSON.parse(String(init?.body));
        return Response.json({ preflight: { result: "pass", blocking: [], notes: [] } });
      }
      return original402;
    },
  });

  const res = await guard(resource, {
    method: "POST",
    headers: { Authorization: "Bearer secret", "PAYMENT-SIGNATURE": "sig" },
  });
  assert.equal(res, original402);
  assert.equal(res.headers.get("PAYMENT-REQUIRED"), "abc123");
  assert.deepEqual(capturedVerdictBody, { resource, method: "POST", budgetUsdc: 0.25 });
  assert.equal(capturedVerdictHeaders?.get("authorization"), null);
  assert.equal(capturedVerdictHeaders?.get("payment-signature"), null);
  assert.equal(capturedVerdictHeaders?.get("sec-gpc"), "1");
});

test("guardedFetch throws VeyraBlockedError when preflight returns block", async () => {
  await assert.rejects(
    guardedFetch(
      resource,
      { method: "GET" },
      {
        budgetUsdc: 0.25,
        verdictUrl,
        fetchImpl: async (url) => {
          if (String(url) === verdictUrl) {
            return Response.json({
              preflight: {
                result: "block",
                blocking: [{ code: "payto_differs_from_catalog", detail: "Payee mismatch" }],
                notes: [{ code: "no_reputation_data", detail: "No history" }],
              },
            });
          }
          return new Response(null, { status: 402 });
        },
      },
    ),
    (error: unknown) => {
      assert(error instanceof VeyraBlockedError);
      assert.equal(error.unavailable, false);
      assert.equal(error.blocking[0]?.code, "payto_differs_from_catalog");
      assert.equal(error.notes[0]?.code, "no_reputation_data");
      return true;
    },
  );
});

test("guardedFetch fails closed by default when Veyra is unavailable, and allows only when opted out", async () => {
  for (const brokenVerdict of [
    () => Promise.resolve(new Response("down", { status: 503 })),
    () => Promise.reject(new Error("network_down")),
    () => Promise.resolve(new Response("{}", { status: 200 })),
  ]) {
    await assert.rejects(
      guardedFetch(
        resource,
        { method: "GET" },
        {
          budgetUsdc: 0.25,
          verdictUrl,
          fetchImpl: async (url) => (String(url) === verdictUrl ? brokenVerdict() : new Response(null, { status: 402 })),
        },
      ),
      (error: unknown) => {
        assert(error instanceof VeyraBlockedError);
        assert.equal(error.unavailable, true);
        assert.equal(error.blocking[0]?.code, "veyra_unavailable");
        return true;
      },
    );
  }

  const allowed = await guardedFetch(
    resource,
    { method: "GET" },
    {
      budgetUsdc: 0.25,
      verdictUrl,
      onVeyraUnavailable: "allow",
      fetchImpl: async (url) => (String(url) === verdictUrl
        ? new Response("down", { status: 503 })
        : new Response("402-body", { status: 402 })),
    },
  );
  assert.equal(allowed.status, 402);
  assert.equal(await allowed.text(), "402-body");
});
