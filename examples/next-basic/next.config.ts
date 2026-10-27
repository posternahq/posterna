import { withPosternaConfig } from "@posterna/next/config";
import type { NextConfig } from "next";

const config: NextConfig = {};

// Builds agents.yaml (or the file POSTERNA_POLICY names) into the proxy, so it
// works where the proxy cannot read files at run time, such as on Vercel.
export default withPosternaConfig(config);
