// SPDX-License-Identifier: Apache-2.0
// Types of netlog.mjs, for test/netlog.test.ts.

export interface NetlogRequest {
  urls: string[];
  initiator: string | null;
}

export function netlogRequests(text: string): NetlogRequest[];

export function classify(
  requests: NetlogRequest[],
  options: { standInHost: string },
): {
  violations: Array<{ url: string; initiator: string | null; why?: string }>;
  exempt: Array<{ url: string; initiator: null }>;
  hosts: Record<string, number>;
};
