# Monad Metropolis Development

Use the locally installed MONSKILLS when relevant. Start with `monskill` and
consult only the needed topic skills. Live official documentation overrides
stale facts in third-party skills.

Official sources of truth:
- https://docs.monad.xyz/ai/developers
- https://docs.monad.xyz/ai/current-facts

Prioritize official Monad documentation for network configuration, ERC-8004
registries, P256/WebAuthn at 0x0100 (EIP-7951), Foundry execution, and transaction
and gas semantics. Use Context7 for current library APIs.

## Scope and authorization

- Work only in the `metropolis-monad` branch/worktree.
- Preserve existing Arc production behavior and reuse the Veyra trust engine.
- Do not replace payment or identity architecture with unrelated templates.
- Keep autonomous spending frozen.
- Never expose private keys, secrets, environment files, or signing material.
- Never deploy or spend funds without explicit approval for the specific action.
- Never push, publish, or mutate production without explicit authorization.
- Preserve unrelated work in the primary checkout.
- Local implementation and dependencies for the isolated Metropolis prototype
  are authorized by the user's request to begin. See `docs/METROPOLIS.md` for scope.
- Private planning documents and locally installed skills must remain outside
  the public Git history. Stage public files explicitly.

## Verification

- Use official Foundry 1.8+ with Monad execution enabled; avoid the legacy fork.
- Test all authorization and replay-protection paths.
- Generate real cryptographic WebAuthn fixtures; never replace verification
  with mocks when claiming the passkey path works.
- Do not claim successful onchain verification without a real receipt or a
  reproducible test, and distinguish fork tests from deployed transactions.
- Read the installed Next.js guides before adding frontend code.

<!-- context7 -->
Use Context7 MCP to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service — even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use even when you think you know the answer — your training data may not reflect recent changes. Prefer this over web search for library docs.

Do not use for: refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

## Steps

1. Always start with `resolve-library-id` using the library name and what to look up in the library's documentation, unless the user provides an exact library ID in `/org/project` format
2. Pick the best match (ID format: `/org/project`) by: exact name match, description relevance, code snippet count, source reputation (High/Medium preferred), and benchmark score (higher is better). If results don't look right, try alternate names or queries (e.g., "next.js" not "nextjs", or rephrase the question). Use version-specific IDs when the user mentions a version
3. `query-docs` with the selected library ID and what to look up in the library's documentation (not single words), scoped to a single concept. If the question spans multiple distinct concepts (e.g. routing and auth and caching), make a separate `query-docs` call per concept with the same library ID, unless the question is about how the concepts interact — combined queries dilute ranking and return shallow results for each topic
4. Answer using the fetched docs
<!-- context7 -->

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
