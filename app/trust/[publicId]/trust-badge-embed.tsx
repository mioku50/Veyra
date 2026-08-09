"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BRAND } from "@/lib/brand";

type Variant = "score" | "status" | "arc";

const variants: Array<{ value: Variant; label: string }> = [
  { value: "score", label: `${BRAND.name} Trust | score` },
  { value: "status", label: `${BRAND.name} | status` },
  { value: "arc", label: `${BRAND.name} | Arc verified` },
];

export function TrustBadgeEmbed({
  appUrl,
  profileId,
}: {
  appUrl: string;
  profileId: string;
}) {
  const [variant, setVariant] = useState<Variant>("score");
  const [copied, setCopied] = useState(false);
  const badgeUrl = `${appUrl}/api/trust/${profileId}/badge.svg?variant=${variant}`;
  const profileUrl = `${appUrl}/trust/${profileId}`;
  const markdown = useMemo(
    () => `[![Veyra Trust](${badgeUrl})](${profileUrl})`,
    [badgeUrl, profileUrl],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        {variants.map((item) => (
          <Button
            key={item.value}
            type="button"
            size="sm"
            variant={variant === item.value ? "default" : "outline"}
            onClick={() => setVariant(item.value)}
          >
            {item.label}
          </Button>
        ))}
      </div>
      <a href={profileUrl} className="w-fit" aria-label="Open this Veyra Trust Profile">
        <Image
          src={badgeUrl}
          alt={`${BRAND.name} Trust badge preview`}
          width={360}
          height={20}
          unoptimized
          className="h-5 w-auto"
        />
      </a>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <code className="overflow-x-auto rounded-md border bg-black/30 p-3 text-xs">
          {markdown}
        </code>
        <Button type="button" variant="outline" onClick={copy}>
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy Markdown"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        The image is generated server-side. Its ETag changes with the latest canonical
        snapshot, and the badge links back to this public profile.
      </p>
    </div>
  );
}
