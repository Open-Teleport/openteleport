import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require(process.env.OPENTELEPORT_BRAND_SHARP || 'C:/Users/nadru/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#ffffff"/><g fill="none" stroke="#e9edf0" stroke-width="4"><ellipse cx="1070" cy="315" rx="180" ry="300"/><ellipse cx="1000" cy="315" rx="180" ry="300"/></g><g transform="translate(64 78)" fill="none" stroke="#171717" stroke-width="5" stroke-linecap="square"><path d="M49 15 A23 23 0 1 0 49 49"/><path d="M26 32H59M51 24L59 32L51 40"/></g><g fill="#171717" font-family="Segoe UI, Arial, sans-serif"><text x="148" y="126" font-size="46" font-weight="600" letter-spacing="-1.5">OpenTeleport</text><text x="64" y="306" font-size="62" font-weight="500" letter-spacing="-2">Your agent. Anywhere.</text><text x="66" y="368" font-size="25" fill="#5a5a58">Move your AI agent between apps in one command.</text><text x="66" y="550" font-size="20" fill="#5a5a58">openteleport.dev</text></g></svg>`;
await fs.writeFile('site/public/brand/social-og-light.svg', svg);
await sharp(Buffer.from(svg)).png().toFile('site/public/brand/social-og-light.png');
