import type { Hex } from "viem";
import { toDiagnosticAssertion, signMetropolisDiagnosticChallenge,
  type AssertionMetadata, type MetropolisCredential } from "./passkey.ts";

/** V2-only validation. V1 packages continue to use their stricter parser. */
export function toPasskeyV2Assertion(signature: Hex, metadata: AssertionMetadata, challenge: Hex, origin: string) {
  return toDiagnosticAssertion(signature, metadata, challenge, origin);
}

/** Used only for proposals bound to the verified, pinned V2 factory. */
export async function signMetropolisV2Challenge(credential: MetropolisCredential, challenge: Hex, origin: string) {
  return signMetropolisDiagnosticChallenge(credential, challenge, origin);
}
