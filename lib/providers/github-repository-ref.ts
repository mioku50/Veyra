/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

export type GitHubRepositoryRef = {
  owner: string;
  name: string;
  fullName: string;
  canonicalUrl: string;
};

export class InvalidGitHubRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGitHubRepositoryError";
  }
}

export function parseGitHubRepositoryInput(input: unknown): GitHubRepositoryRef {
  if (typeof input !== "string" || !input.trim()) {
    throw new InvalidGitHubRepositoryError("Enter a public GitHub repository URL or owner/repository.");
  }

  const rawInput = input.trim();
  let parts: string[] = [];

  const hasScheme = /^[a-z0-9+.-]+:\/\//i.test(rawInput) || rawInput.startsWith("//");

  if (hasScheme) {
    let url: URL;
    try {
      url = new URL(rawInput.startsWith("//") ? `https:${rawInput}` : rawInput);
    } catch {
      throw new InvalidGitHubRepositoryError("Enter a public GitHub repository URL or owner/repository.");
    }

    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") {
      throw new InvalidGitHubRepositoryError("Only public GitHub repositories (github.com) are supported.");
    }

    parts = url.pathname.split("/").filter(Boolean);
  } else {
    const firstSlash = rawInput.indexOf("/");
    const firstSegment = (firstSlash !== -1 ? rawInput.slice(0, firstSlash) : rawInput).toLowerCase();
    const remaining = firstSlash !== -1 ? rawInput.slice(firstSlash + 1) : "";

    if (firstSegment === "github.com" || firstSegment === "www.github.com") {
      parts = remaining.split("/").filter(Boolean);
    } else if (
      (firstSegment.includes(".") && firstSegment !== "." && firstSegment !== "..") ||
      firstSegment === "localhost" ||
      firstSegment.includes(":") ||
      /^\[.*\]$/.test(firstSegment)
    ) {
      throw new InvalidGitHubRepositoryError("Only public GitHub repositories (github.com) are supported.");
    } else {
      parts = rawInput.split("/").filter(Boolean);
    }
  }

  if (parts.length < 2) {
    throw new InvalidGitHubRepositoryError("Enter a valid GitHub repository in owner/repository format.");
  }

  const rawOwner = parts[0];
  const rawName = parts[1].replace(/\.git$/i, "");

  if (
    !rawOwner ||
    !rawName ||
    rawOwner === "." ||
    rawOwner === ".." ||
    rawName === "." ||
    rawName === ".." ||
    !/^[a-z0-9_.-]+$/i.test(rawOwner) ||
    !/^[a-z0-9_.-]+$/i.test(rawName)
  ) {
    throw new InvalidGitHubRepositoryError("Repository owner and name contain invalid characters.");
  }

  const canonicalOwner = rawOwner.toLowerCase();
  const canonicalName = rawName.toLowerCase();
  const fullName = `${canonicalOwner}/${canonicalName}`;

  return {
    owner: canonicalOwner,
    name: canonicalName,
    fullName,
    canonicalUrl: `https://github.com/${canonicalOwner}/${canonicalName}`,
  };
}
