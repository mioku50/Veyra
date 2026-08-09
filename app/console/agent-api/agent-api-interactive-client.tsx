"use client";

import { useState } from "react";
import { Check, Code2, Copy, Play, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";

const codeExamples = {
  typescript: `import { AgentCommerceApiError, AgentCommerceClient } from "@arc-agent-commerce/sdk";

const client = new AgentCommerceClient({
  baseUrl: "https://agent-commerce-six.vercel.app",
  credential: process.env.ARC_AGENT_COMMERCE_API_KEY!,
});

try {
  const { report } = await client.executeWorkflow({
    workflow: "github_due_diligence",
    repository: "circlefin/developer-controlled-wallets-web-sdk",
  }, {
    // Persist these keys in a real agent so a process restart replays safely.
    quoteIdempotencyKey: "github-quote-001",
    runIdempotencyKey: "github-run-001",
    wait: {
      onStatus: ({ status, progress }) =>
        console.log(status, Math.round(progress * 100) + "%"),
    },
  });

  console.log(report.verdict);
  console.log(report.verification);
} catch (error) {
  if (error instanceof AgentCommerceApiError) {
    console.error(error.code, error.retryable, error.requestId);
  }
  throw error;
}`,

  python: `# No third-party dependency required.
import json, os, time, urllib.request, uuid

BASE = "https://agent-commerce-six.vercel.app"
TOKEN = os.environ["ARC_AGENT_COMMERCE_API_KEY"]

def call(method, path, body=None, key=None):
    headers = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"}
    if body is not None: headers["Content-Type"] = "application/json"
    if key: headers["Idempotency-Key"] = key
    request = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers,
        method=method,
    )
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read())

quote = call("POST", "/api/agent/v1/quotes", {
    "workflow": "github_due_diligence",
    "repository": "circlefin/developer-controlled-wallets-web-sdk",
}, "github-quote-001")

run = call("POST", "/api/agent/v1/runs", {
    "quoteId": quote["quoteId"],
}, "github-run-001")

while True:
    status = call("GET", f"/api/agent/v1/runs/{run['runId']}")
    if status["status"] in ("completed", "completed_with_warnings", "failed", "expired"):
        break
    time.sleep(max(status.get("pollAfterMs", 2000) / 1000, 0.25))

report = call("GET", f"/api/agent/v1/reports/{status.get('reportId', run['runId'])}")
print(json.dumps({"verdict": report.get("verdict"), "verification": report["verification"]}, indent=2))`,

  curl: `export ARC_AGENT_COMMERCE_BASE_URL="https://agent-commerce-six.vercel.app"

# Discover curated workflows
curl "$ARC_AGENT_COMMERCE_BASE_URL/api/agent/v1/workflows" \\
  -H "Authorization: Bearer $ARC_AGENT_COMMERCE_API_KEY"

# Create an immutable quote
curl -X POST "$ARC_AGENT_COMMERCE_BASE_URL/api/agent/v1/quotes" \\
  -H "Authorization: Bearer $ARC_AGENT_COMMERCE_API_KEY" \\
  -H "Idempotency-Key: github-quote-001" \\
  -H "Content-Type: application/json" \\
  -d '{"workflow":"github_due_diligence","repository":"circlefin/developer-controlled-wallets-web-sdk"}'

# Use quoteId from the response
curl -X POST "$ARC_AGENT_COMMERCE_BASE_URL/api/agent/v1/runs" \\
  -H "Authorization: Bearer $ARC_AGENT_COMMERCE_API_KEY" \\
  -H "Idempotency-Key: github-run-001" \\
  -H "Content-Type: application/json" \\
  -d '{"quoteId":"QUOTE_ID"}'`,
};

type TabKey = keyof typeof codeExamples;

export function AgentApiInteractiveClient() {
  const [activeTab, setActiveTab] = useState<TabKey>("typescript");
  const [copied, setCopied] = useState(false);

  function copyActiveSnippet() {
    void navigator.clipboard.writeText(codeExamples[activeTab]).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    }).catch(() => setCopied(false));
  }

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b pb-3">
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button
            size="sm"
            variant={activeTab === "typescript" ? "default" : "outline"}
            onClick={() => setActiveTab("typescript")}
            className="gap-2 font-mono text-xs"
          >
            <Code2 className="size-3.5" />
            TypeScript SDK
          </Button>
          <Button
            size="sm"
            variant={activeTab === "python" ? "default" : "outline"}
            onClick={() => setActiveTab("python")}
            className="gap-2 font-mono text-xs"
          >
            <Terminal className="size-3.5" />
            Python
          </Button>
          <Button
            size="sm"
            variant={activeTab === "curl" ? "default" : "outline"}
            onClick={() => setActiveTab("curl")}
            className="gap-2 font-mono text-xs"
          >
            <Play className="size-3.5" />
            cURL
          </Button>
        </div>

        <Button size="sm" variant="ghost" onClick={copyActiveSnippet} className="gap-2 text-xs">
          {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>

      <div className="relative min-w-0 max-w-full overflow-hidden rounded-md bg-zinc-950 p-4 font-mono text-xs text-zinc-100">
        <pre className="max-w-full overflow-x-auto whitespace-pre leading-relaxed">
          <code>{codeExamples[activeTab]}</code>
        </pre>
      </div>
    </div>
  );
}
