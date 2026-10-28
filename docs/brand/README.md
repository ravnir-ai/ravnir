# Ravnir companion

The current product mark is the dark companion raven with amber eyes, chosen from direction 03 of the logo exploration on October 25, 2026. It is a rounded, slightly turned raven head with a charcoal beak and an observant expression.

The artwork was refined with the built-in image generation tool. `ravnir-companion-master.png` is the transparent raster master, not a vector file. `companion-prompt.txt` records the generation prompt. The former orb SVGs are preserved under `archive/` and are no longer the current product logo.

## Exports

- `public/logo.png`: 640 by 640, transparent, for in-page branding and documentation.
- `public/icon-192.png`, `public/icon-512.png`: opaque midnight tiles for installed app icons. The Apple touch icon uses the 512-pixel tile.
- `public/favicon.png`: 64-pixel opaque tile, displayed at smaller browser sizes.
- `public/og.jpg`: 1200 by 630 social card with the mark, wordmark and product description.
- `companion-preview.png`: visual check on light and dark backgrounds and at small sizes.

Regenerate the exports with `node scripts/build-brand.mjs` after installing the project's Playwright Chromium. This script resamples the approved master and lays out the social card; it does not redraw the artwork. Runtime asset links use `?v=companion-20261025` to refresh browser caches. Increment the version when replacing the artwork again.

The palette is midnight `#181d2b`, near-white `#f5f4f0` and amber `#ffb547`. Preserve the transparent master and use opaque tiles for home-screen icons. Do not stretch the head, add a surrounding glow or put small text inside an app icon.

The mark identifies Ravnir. Agents retain their individual customizable animated appearances.
