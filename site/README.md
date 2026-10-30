# openteleport.dev

The landing page. A static [Astro](https://astro.build) site with its own `package.json`, apart from the npm package in the repository root.

```bash
cd site
npm install
npm run dev      # http://localhost:4321
npm run build    # dist/
npm run preview  # serves dist/
```

No CMS, no backend, no analytics. System sans-serif and monospace fonts require no downloads at build time or in the browser. The default theme is light; an explicit saved dark/light preference is respected.

## Landing and branding (2026-10-30)

There is one landing with two themes, not two independent implementations. `RESEARCH.md` preserves the earlier A (Void portal) and B (Cipher terminal) concepts and explains the original merge. The initial implementation kept B's terminal transition but only A's dark colors. The current scroll transition adds a portal crossing between terminal screens in both themes, with a static alternative for reduced motion.

The landing now includes MCP and native-plugin setup links. Version text and SoftwareApplication structured data read the root package version. SEO includes canonical URLs, a light 1200×630 social image, robots.txt and sitemap.xml. Concept boards in `public/brand/concepts/` are review material, not final logo selections. The four latest light proposals are 04–07; generation prompts are stored beside them. The old ZIP is an archive of the first dark direction.

Deployment remains through this repository's existing Vercel project. Local edits do not update the public site or publish an npm release.

## Deploying on Vercel

Create a Vercel project from this repository and set its **Root Directory** to `site/`. Vercel detects Astro: build command `astro build`, output directory `dist`. A static site needs no adapter.

## Research

`RESEARCH.md` records the libraries that were considered, their licences (checked in each repository's `LICENSE` file) and the three UI concepts the design was chosen from.
