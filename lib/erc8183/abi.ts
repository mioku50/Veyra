/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

export const ERC8183_AGENTIC_COMMERCE_ABI = [
  {
    type: "function",
    name: "createJob",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "provider" },
      { type: "address", name: "evaluator" },
      { type: "uint256", name: "expiredAt" },
      { type: "string", name: "description" },
      { type: "address", name: "hook" },
    ],
    outputs: [{ type: "uint256", name: "jobId" }],
  },
  {
    type: "function",
    name: "setBudget",
    stateMutability: "nonpayable",
    inputs: [
      { type: "uint256", name: "jobId" },
      { type: "uint256", name: "amount" },
      { type: "bytes", name: "optParams" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "fund",
    stateMutability: "nonpayable",
    inputs: [
      { type: "uint256", name: "jobId" },
      { type: "bytes", name: "optParams" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "submit",
    stateMutability: "nonpayable",
    inputs: [
      { type: "uint256", name: "jobId" },
      { type: "bytes32", name: "deliverableHash" },
      { type: "bytes", name: "optParams" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "complete",
    stateMutability: "nonpayable",
    inputs: [
      { type: "uint256", name: "jobId" },
      { type: "bytes32", name: "reason" },
      { type: "bytes", name: "optParams" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "reject",
    stateMutability: "nonpayable",
    inputs: [
      { type: "uint256", name: "jobId" },
      { type: "bytes32", name: "reason" },
      { type: "bytes", name: "optParams" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getJob",
    stateMutability: "view",
    inputs: [{ type: "uint256", name: "jobId" }],
    outputs: [
      {
        type: "tuple",
        name: "",
        components: [
          { type: "uint256", name: "id" },
          { type: "address", name: "client" },
          { type: "address", name: "provider" },
          { type: "address", name: "evaluator" },
          { type: "string", name: "description" },
          { type: "uint256", name: "budget" },
          { type: "uint256", name: "expiredAt" },
          { type: "uint8", name: "status" },
          { type: "address", name: "hook" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "JobCreated",
    inputs: [
      { type: "uint256", name: "jobId", indexed: true },
      { type: "address", name: "client", indexed: true },
      { type: "address", name: "provider", indexed: true },
      { type: "address", name: "evaluator", indexed: false },
      { type: "uint256", name: "expiredAt", indexed: false },
      { type: "address", name: "hook", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "JobSubmitted",
    inputs: [
      { type: "uint256", name: "jobId", indexed: true },
      { type: "address", name: "provider", indexed: true },
      { type: "bytes32", name: "deliverableHash", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "JobCompleted",
    inputs: [
      { type: "uint256", name: "jobId", indexed: true },
      { type: "address", name: "evaluator", indexed: true },
      { type: "bytes32", name: "reason", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "JobRejected",
    inputs: [
      { type: "uint256", name: "jobId", indexed: true },
      { type: "bytes32", name: "reason", indexed: true },
      { type: "bytes", name: "optParams", indexed: false },
    ],
  },
] as const;

export const VEYRA_ERC8183_EVALUATOR_ABI = [
  {
    type: "function",
    name: "executeVerdict",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "tuple",
        name: "verdict",
        components: [
          { type: "address", name: "agenticCommerce" },
          { type: "uint256", name: "jobId" },
          { type: "bytes32", name: "deliverableHash" },
          { type: "bytes32", name: "reportHash" },
          { type: "bytes32", name: "policyHash" },
          { type: "uint8", name: "decision" },
          { type: "uint64", name: "evaluatedAt" },
          { type: "uint64", name: "validUntil" },
          { type: "uint256", name: "nonce" },
        ],
      },
      { type: "bytes", name: "signature" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "hashVerdict",
    stateMutability: "view",
    inputs: [
      {
        type: "tuple",
        name: "verdict",
        components: [
          { type: "address", name: "agenticCommerce" },
          { type: "uint256", name: "jobId" },
          { type: "bytes32", name: "deliverableHash" },
          { type: "bytes32", name: "reportHash" },
          { type: "bytes32", name: "policyHash" },
          { type: "uint8", name: "decision" },
          { type: "uint64", name: "evaluatedAt" },
          { type: "uint64", name: "validUntil" },
          { type: "uint256", name: "nonce" },
        ],
      },
    ],
    outputs: [{ type: "bytes32", name: "" }],
  },
  {
    type: "event",
    name: "EvaluationExecuted",
    inputs: [
      { type: "address", name: "agenticCommerce", indexed: true },
      { type: "uint256", name: "jobId", indexed: true },
      { type: "bytes32", name: "reportHash", indexed: true },
      { type: "bytes32", name: "deliverableHash", indexed: false },
      { type: "bytes32", name: "policyHash", indexed: false },
      { type: "uint8", name: "decision", indexed: false },
      { type: "address", name: "attester", indexed: false },
      { type: "address", name: "relayer", indexed: false },
    ],
  },
] as const;
