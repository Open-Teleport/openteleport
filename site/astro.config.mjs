// @ts-check
import { defineConfig } from "astro/config";

// Static output: Vercel needs no adapter for it. The Vercel project's root directory is `site/`.
export default defineConfig({
  site: "https://openteleport.dev",
  output: "static",
  trailingSlash: "never",
  build: { inlineStylesheets: "auto" },
});
