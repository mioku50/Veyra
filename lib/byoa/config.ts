import { getAddress, isAddress, type Address } from "viem";
import { ARC_TESTNET_CHAIN_ID } from "../wallet/arc.ts";

export class ByoaConfigAccessError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function enabled(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

function addressSet(value: string | undefined) {
  const result = new Set<string>();
  for (const item of value?.split(",") ?? []) {
    const candidate = item.trim();
    if (!candidate) continue;
    if (!isAddress(candidate)) throw new Error("BYOA canary allowlists must contain valid EVM addresses.");
    result.add(getAddress(candidate).toLowerCase());
  }
  return result;
}

export function originSet(environment: NodeJS.ProcessEnv = process.env) {
  /* The deployment's own origin is trusted without being configured.
     This guard exists to refuse *cross*-origin callers; a page refusing its own
     server because nobody set an environment variable is not a security
     property, it is an outage — and it was one: moving to a new domain made
     every decision fail with "BYOA request origin is not allowed". Vercel
     publishes both the stable production host and this deployment's own host,
     and neither can be forged by a third party. */
  const vercelHosts = [
    environment.VERCEL_PROJECT_PRODUCTION_URL,
    environment.VERCEL_URL,
    environment.VERCEL_BRANCH_URL,
  ]
    .map((host) => host?.trim())
    .filter((host): host is string => Boolean(host))
    .map((host) => (/^https?:\/\//i.test(host) ? host : `https://${host}`));

  const values = [
    ...(environment.BYOA_ALLOWED_ORIGINS?.split(",") ?? []),
    environment.NEXT_PUBLIC_APP_URL,
    environment.NEXT_PUBLIC_SITE_URL,
    ...vercelHosts,
  ];
  const origins = new Set<string>();
  for (const item of values) {
    const candidate = item?.trim();
    if (!candidate) continue;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      // A malformed entry must not take down every origin beside it.
      continue;
    }
    origins.add(url.origin);
  }
  if (environment.NODE_ENV !== "production") {
    origins.add("http://localhost:3000");
    origins.add("http://127.0.0.1:3000");
  }
  return origins;
}

function secret(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (!value || value.length < 32) throw new Error(`${name} must contain at least 32 characters.`);
  return value;
}

export function getByoaConfig(environment: NodeJS.ProcessEnv = process.env) {
  const origins = originSet(environment);
  if (origins.size === 0) throw new Error("BYOA_ALLOWED_ORIGINS or NEXT_PUBLIC_APP_URL must be configured.");
  return {
    enabled: enabled(environment.BYOA_ENABLED),
    publicRegistrationEnabled: enabled(environment.BYOA_PUBLIC_REGISTRATION_ENABLED),
    chainId: ARC_TESTNET_CHAIN_ID,
    origins,
    canaryOwnerWallets: addressSet(environment.BYOA_CANARY_OWNER_WALLETS),
    canaryAgentWallets: addressSet(environment.BYOA_CANARY_AGENT_WALLETS),
    managementSessionSecret: secret(environment, "BYOA_MANAGEMENT_SESSION_SECRET"),
    credentialPepper: secret(environment, "BYOA_CREDENTIAL_PEPPER"),
    challengeTtlSeconds: 300,
    sessionTtlSeconds: 3_600,
  };
}

export function getByoaDiagnostic(environment: NodeJS.ProcessEnv = process.env) {
  try {
    const config = getByoaConfig(environment);
    return {
      configured: true,
      enabled: config.enabled,
      publicRegistrationEnabled: config.publicRegistrationEnabled,
      canaryOnly: !config.publicRegistrationEnabled,
      chainId: config.chainId,
      allowedOriginCount: config.origins.size,
      canaryOwnerCount: config.canaryOwnerWallets.size,
      canaryAgentCount: config.canaryAgentWallets.size,
      custody: "none" as const,
      credentialStorage: "hmac_sha256_only" as const,
    };
  } catch {
    return {
      configured: false,
      enabled: false,
      publicRegistrationEnabled: false,
      canaryOnly: true,
      chainId: ARC_TESTNET_CHAIN_ID,
      allowedOriginCount: 0,
      canaryOwnerCount: 0,
      canaryAgentCount: 0,
      custody: "none" as const,
      credentialStorage: "hmac_sha256_only" as const,
    };
  }
}

export function requireByoaEnabled() {
  const config = getByoaConfig();
  if (!config.enabled) {
    throw new ByoaConfigAccessError(
      "BYOA is not enabled for this deployment.",
      "feature_disabled",
      503,
    );
  }
  return config;
}

export function requireAllowedOrigin(requestUrl: string, originHeader?: string | null) {
  const config = requireByoaEnabled();
  let requestOrigin: string;
  let suppliedOrigin: string;
  try {
    requestOrigin = new URL(requestUrl).origin;
    suppliedOrigin = originHeader ? new URL(originHeader).origin : requestOrigin;
  } catch {
    throw new ByoaConfigAccessError("BYOA request origin is invalid.", "origin_denied", 403);
  }
  if (!config.origins.has(requestOrigin) || !config.origins.has(suppliedOrigin)) {
    throw new ByoaConfigAccessError("BYOA request origin is not allowed.", "origin_denied", 403);
  }
  return suppliedOrigin;
}

export function isCanaryOwnerAllowed(wallet: Address, environment: NodeJS.ProcessEnv = process.env) {
  const config = getByoaConfig(environment);
  return config.publicRegistrationEnabled || config.canaryOwnerWallets.has(wallet.toLowerCase());
}

export function isCanaryAgentAllowed(wallet: Address, environment: NodeJS.ProcessEnv = process.env) {
  const config = getByoaConfig(environment);
  return config.publicRegistrationEnabled || config.canaryAgentWallets.has(wallet.toLowerCase());
}
