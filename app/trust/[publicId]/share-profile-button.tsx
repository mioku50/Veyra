"use client";

import { useState } from "react";
import { Check, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ShareProfileButton({ title }: { title: string }) {
  const [copied, setCopied] = useState(false);

  async function share() {
    try {
      const url = window.location.href;
      if (navigator.share) {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Button variant="outline" onClick={() => void share()}>
      {copied ? <Check /> : <Share2 />}
      {copied ? "Link copied" : "Share"}
    </Button>
  );
}
