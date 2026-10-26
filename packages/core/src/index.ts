import { version } from "../package.json";

/** The version of @posterna/core, read from its package.json at build time. */
export const VERSION: string = version;

export {
  decodeBase64Url,
  TRUSTED_DIRECTORY_KEYS,
  type TrustedDirectoryKey,
  verifyDirectorySignature,
} from "./directory/signature";
export { DEFAULT_BASE_URL, type DirectoryOptions, type DirectorySnapshot } from "./directory/store";
export type * from "./directory/types";
export type { ProxyOptions, ResolvedClient } from "./verifier/client";
export {
  DEFAULT_VERDICT_HEADERS,
  stripInboundHeaders,
  type VerdictHeaderNames,
  verdictHeaders,
} from "./verifier/headers";
export type { DnsResolver, ReverseDnsOptions } from "./verifier/rdns";
export type { RequestLike } from "./verifier/request";
export type { Verdict, VerdictResult, VerificationMethod } from "./verifier/types";
export {
  createVerifier,
  type Verifier,
  type VerifierOptions,
  type VerifierState,
  type VerifyCallOptions,
  verify,
} from "./verifier/verifier";
