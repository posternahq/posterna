import type { Purpose } from "../directory/types";

/** The label every request gets (docs/SPEC.md section 4.6). */
export type Verdict =
  | "verified_by_signature"
  | "verified_by_ip"
  | "declared_unverifiable"
  | "claimed_failed"
  | "unknown_automation"
  | "human";

export type VerificationMethod = "signature" | "ip" | "rdns" | "none";

/** What `verify()` returns. It never throws. */
export interface VerdictResult {
  verdict: Verdict;
  /** Directory slug of the operator the request claims or proved to be. */
  operator?: string;
  agent?: string;
  purpose?: Purpose;
  method?: VerificationMethod;
  /** Human-readable reason. Never contains IPs, URLs or header values. */
  note?: string;
  /** Set when a fail-open path was taken. */
  error?: string;
}
