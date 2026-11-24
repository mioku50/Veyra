"use client";

/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { useState } from "react";
import { Check, Copy } from "lucide-react";

const SNIPPETS = [
  {
    id: "claude-code",
    title: "Claude Code (MCP)",
    code: "claude mcp add --transport http veyra-trust https://agent-commerce-six.vercel.app/api/mcp",
  },
  {
    id: "mcp-json",
    title: "Cursor & VS Code (MCP JSON)",
    code: `{
  "mcpServers": {
    "veyra-trust": {
      "url": "https://agent-commerce-six.vercel.app/api/mcp"
    }
  }
}`,
  },
  {
    id: "rest-curl",
    title: "REST API (curl)",
    code: `curl -sS -X POST https://agent-commerce-six.vercel.app/api/x402/v1/verdict \\
  -H 'Content-Type: application/json' \\
  -d '{"resource":"https://api.aisa.one/apis/v2/apollo/labels"}'`,
  },
] as const;

export function ConnectAgent() {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function copy(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(id);
      window.setTimeout(() => {
        setCopiedId((current) => (current === id ? null : current));
      }, 2000);
    } catch {
      // Clipboard API may be unavailable in restricted contexts.
    }
  }

  return (
    <section aria-labelledby="connect-agent-heading" className="space-y-4">
      <div className="space-y-1">
        <h2 id="connect-agent-heading" className="text-lg font-semibold text-foreground">
          Connect to your agent
        </h2>
        <p className="text-sm text-muted-foreground">
          Free, unauthenticated, and no API key required for live preflight checks.
        </p>
      </div>

      <div className="grid gap-3">
        {SNIPPETS.map((snippet) => {
          const isCopied = copiedId === snippet.id;
          return (
            <div
              key={snippet.id}
              className="min-w-0 rounded-xl border border-white/10 bg-[#0b0f19]/70 p-4"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">{snippet.title}</span>
                <button
                  type="button"
                  onClick={() => void copy(snippet.id, snippet.code)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-foreground hover:bg-white/10"
                >
                  {isCopied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
                  {isCopied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="min-w-0 max-w-full overflow-x-auto rounded-lg bg-black/40 p-3 font-mono text-xs leading-relaxed text-foreground">
                <code>{snippet.code}</code>
              </pre>
            </div>
          );
        })}
      </div>
    </section>
  );
}
