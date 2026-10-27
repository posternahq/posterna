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

/**
 * Reason codes (docs/SPEC.md section 4.6). The list is closed: counters and
 * the cloud reject anything else.
 */
export const REASON_CODES = [
  // Signature path
  "signature_invalid",
  "expired",
  "created_in_future",
  "validity_too_long",
  "nonce_replayed",
  "nonce_rejected",
  "profile_rejected",
  "malformed_signature",
  "unknown_kid",
  "no_keys",
  "unsigned",
  "unlisted_signature_agent",
  // IP and reverse DNS path
  "outside_ip_list",
  "rdns_mismatch",
  "rdns_unconfirmed",
  "rdns_pending",
  "no_dns",
  "no_client_address",
  "nothing_published",
  "community_token_on_browser",
  // Why a request with no claim looks automated
  "no_user_agent",
  "non_browser_user_agent",
  "automation_token",
  "missing_accept",
  "missing_accept_language",
  // Fail-open paths
  "directory_unavailable",
  "clock_invalid",
  "rdns_error",
  "library_unsupported",
  "library_error",
  "unexpected_error",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** What `verify()` returns. It never throws. */
export interface VerdictResult {
  verdict: Verdict;
  /** Directory slug of the operator the request claims or proved to be. */
  operator?: string;
  agent?: string;
  purpose?: Purpose;
  method?: VerificationMethod;
  /**
   * Why the request got this verdict, as a stable code for counters
   * (docs/SPEC.md sections 4.6 and 7). Set on every verdict except verified
   * and human, and on fail-open results. Never carries request data.
   */
  reason?: ReasonCode;
  /** Human-readable reason. Never contains IPs, URLs or header values. */
  note?: string;
  /** Set when a fail-open path was taken. */
  error?: string;
}
