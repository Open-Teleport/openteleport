# openteleport.dev

The landing page. A static [Astro](https://astro.build) site with its own `package.json`, apart from the npm package in the repository root.

```bash
cd site
npm install
npm run dev      # http://localhost:4321
npm run build    # dist/
npm run preview  # serves dist/
```

No CMS, no backend, no analytics. Fonts (Cormorant Garamond, JetBrains Mono, both OFL) are fetched from Fontsource at build time and served from this site, so the page makes no third-party requests.

## Deploying on Vercel

Create a Vercel project from this repository and set its **Root Directory** to `site/`. Vercel detects Astro: build command `astro build`, output directory `dist`. A static site needs no adapter.

## Research

`RESEARCH.md` records the libraries that were considered, their licences (checked in each repository's `LICENSE` file) and the three UI concepts the design was chosen from.
