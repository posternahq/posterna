import { withPosternaConfig } from "@posterna/next/config";
import type { NextConfig } from "next";

const config: NextConfig = {};

// Builds agents.yaml (or the file POSTERNA_POLICY names) into the middleware and
// route handlers, so they work where files cannot be read at run time, such as
// on Vercel.
export default withPosternaConfig(config);
