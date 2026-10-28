// @ts-check
import { defineConfig, fontProviders } from "astro/config";

// Static output: Vercel needs no adapter for it. The Vercel project's root directory is `site/`.
// Fonts are fetched at build time and served from this site, with preload links and metric-matched fallbacks.
export default defineConfig({
  site: "https://openteleport.dev",
  output: "static",
  trailingSlash: "never",
  build: { inlineStylesheets: "auto" },
  fonts: [
    {
      provider: fontProviders.fontsource(),
      name: "Cormorant Garamond",
      cssVariable: "--font-display",
      weights: ["300", "400"],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["Georgia", "serif"],
    },
    {
      provider: fontProviders.fontsource(),
      name: "JetBrains Mono",
      cssVariable: "--font-mono",
      weights: ["400", "500"],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["ui-monospace", "Menlo", "Consolas", "monospace"],
    },
  ],
});
