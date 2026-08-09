"use client";

import { useState } from "react";
import { Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BRAND } from "@/lib/brand";

export function ShareSelectionButton() {
  const [copied, setCopied] = useState(false);
  async function share() {
    try {
      const url = window.location.href;
      if (navigator.share) {
        await navigator.share({ title: `${BRAND.name} Counterparty Selection`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }
  return <Button variant="outline" onClick={() => void share()}><Share2 />{copied ? "Copied" : "Share"}</Button>;
}
