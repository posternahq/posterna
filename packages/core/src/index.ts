import { version } from "../package.json";

/** The version of @posterna/core, read from its package.json at build time. */
export const VERSION: string = version;

export {
  decodeBase64Url,
  TRUSTED_DIRECTORY_KEYS,
  type TrustedDirectoryKey,
  verifyDirectorySignature,
} from "./directory/signature";
export type * from "./directory/types";
