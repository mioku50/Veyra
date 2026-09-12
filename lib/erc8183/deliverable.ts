/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { encodeAbiParameters, keccak256, parseAbiParameters, stringToBytes, toHex } from "viem";
import type { VeyraDeliverableV1 } from "./types.ts";
import { STRUCTURED_DELIVERABLE_V1_POLICY, STRUCTURED_DELIVERABLE_V1_SCHEMA } from "./types.ts";

export const VEYRA_DELIVERABLE_V1_TYPESTRING =
  "VeyraDeliverableV1(uint16 version,string contentUri,bytes32 contentHash,string contentType,string schemaId,bytes32 policyHash)" as const;

export const VEYRA_DELIVERABLE_V1_TYPEHASH = keccak256(
  stringToBytes(VEYRA_DELIVERABLE_V1_TYPESTRING)
);

export function computePolicyHash(policyId: string = STRUCTURED_DELIVERABLE_V1_POLICY): `0x${string}` {
  return keccak256(stringToBytes(policyId));
}

export function computeContentHash(data: string | Uint8Array | Buffer): `0x${string}` {
  const bytes = typeof data === "string" ? stringToBytes(data) : data;
  return keccak256(bytes);
}

export function computeDeliverableHash(deliverable: VeyraDeliverableV1): `0x${string}` {
  const policyHash = computePolicyHash(deliverable.policyId);
  const encoded = encodeAbiParameters(
    parseAbiParameters("bytes32, uint16, bytes32, bytes32, bytes32, bytes32, bytes32"),
    [
      VEYRA_DELIVERABLE_V1_TYPEHASH,
      deliverable.version,
      keccak256(stringToBytes(deliverable.contentUri)),
      deliverable.contentHash,
      keccak256(stringToBytes(deliverable.contentType)),
      keccak256(stringToBytes(deliverable.schemaId)),
      policyHash,
    ],
  );
  return keccak256(encoded);
}

export function prepareDeliverableCommitment(input: {
  contentUri: string;
  contentHash: `0x${string}`;
  contentType?: "application/json";
  schemaId?: typeof STRUCTURED_DELIVERABLE_V1_SCHEMA;
  policyId?: typeof STRUCTURED_DELIVERABLE_V1_POLICY;
}): {
  version: 1;
  deliverable: VeyraDeliverableV1;
  deliverableHash: `0x${string}`;
  policyHash: `0x${string}`;
  submitArgs: {
    deliverable: `0x${string}`;
    optParams: `0x`;
  };
} {
  const deliverable: VeyraDeliverableV1 = {
    version: 1,
    contentUri: input.contentUri,
    contentHash: input.contentHash,
    contentType: input.contentType ?? "application/json",
    schemaId: input.schemaId ?? STRUCTURED_DELIVERABLE_V1_SCHEMA,
    policyId: input.policyId ?? STRUCTURED_DELIVERABLE_V1_POLICY,
  };

  const policyHash = computePolicyHash(deliverable.policyId);
  const deliverableHash = computeDeliverableHash(deliverable);

  return {
    version: 1,
    deliverable,
    deliverableHash,
    policyHash,
    submitArgs: {
      deliverable: deliverableHash,
      optParams: "0x",
    },
  };
}
