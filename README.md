# DontTouchMyVid

Privacy-first video tools — **everything runs in your browser tab**. No uploads, no accounts, no watermarks, no file-size cap.

Live: [donttouchmyvid.com](https://donttouchmyvid.com)

Sister sites: [DontTouchMyDoc](https://donttouchmydoc.com) (PDFs) · [DontTouchMyPic](https://donttouchmypic.com) (images).

## What's live

- **`/compress`** — multi-gigabyte H.264 / HEVC MP4 + MOV → smaller MP4. Three presets (Tiny / Smaller / High), live output-size estimate, hardware-accelerated encode.

Convert / Trim / Mute / Extract audio / Rotate are stubbed and on the roadmap.

## Stack

- **[Astro](https://astro.build)** — static site generation, island architecture.
- **[Tailwind CSS v4](https://tailwindcss.com)** — via `@tailwindcss/vite`.
- **[mp4box.js](https://github.com/gpac/mp4box.js/)** — streaming MP4 demuxer.
- **[mp4-muxer](https://github.com/Vanilagy/mp4-muxer)** — pure-JS MP4 muxer that takes WebCodecs output directly.
- **[WebCodecs](https://www.w3.org/TR/webcodecs/)** — native browser API for hardware-accelerated H.264 decode + encode.
- Deploy target: **Cloudflare Pages** (static output).

No backend, no server-side processing. The site is a static bundle.

## Architecture

The compressor pipeline runs entirely inside a Web Worker so multi-gigabyte files don't lock the UI thread and the encoder heap is isolated from the page:

```
File.stream()                                    src/components/tools/CompressVideoTool.astro
   │                                                          (UI + worker orchestration)
   ▼                                                                       │
mp4box.appendBuffer()  ──► onSamples ──► EncodedVideoChunk[] queue ────────┤
                                                                           ▼
                                              ┌──────────────────────────────────────┐
                                              │  src/workers/encoder.worker.ts       │
                                              │                                       │
                                              │  pump (backpressured: dec ≤ 6, enc ≤ 3)│
                                              │     │                                 │
                                              │     ▼                                 │
                                              │  VideoDecoder ──► VideoFrame ──► VideoEncoder ──► EncodedVideoChunk │
                                              │                                                       │             │
                                              │                                                       ▼             │
                                              │                                                  mp4-muxer          │
                                              │                                                       │             │
                                              │                                                       ▼             │
                                              └──────────────────────────────────── Blob ◄────────────┘             ┘
                                                                                       │
                                                                                       ▼
                                                                              Download MP4
```

The **backpressured pump** is the load-bearing fix for moov-at-end MP4s, where `mp4box.start()` releases all samples synchronously after the file is fully fed. Without it, 40k+ frames pile up in the encoder queue and exhaust the GPU's video memory. With it, queue depths stay tight and a 2GB source compresses without screen flashes or OOMs.

A **live diagnostic panel** under the progress bar surfaces samples-in / frames-decoded / chunks-out + throughput in real time, so the user can literally watch their CPU doing the work — turning the privacy promise into an observable fact.

## Getting started

```bash
npm install
npm run dev
```

Open http://localhost:4321.

### Scripts

| script            | what                                                       |
| ----------------- | ---------------------------------------------------------- |
| `npm run dev`     | Start the dev server                                       |
| `npm run build`   | Produce a static build in `./dist`                         |
| `npm run preview` | Preview the built site locally                             |
| `npm run deploy`  | Build and deploy to Cloudflare Pages (requires `wrangler`) |

## Deploying

Production deploys are **automatic on push to `main`** via a GitHub Actions workflow at `.github/workflows/deploy.yml`. The workflow builds the site and ships it to Cloudflare Pages via `wrangler`.

### Required GitHub secrets

Set these at **Repo → Settings → Secrets and variables → Actions → New repository secret**:

| Secret                      | Where to get it                                                                 |
| --------------------------- | ------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`      | Cloudflare dashboard → **My Profile → API Tokens → Create Token** → use the **"Edit Cloudflare Workers"** template (it includes Pages edit), or a custom token with *Account → Cloudflare Pages → Edit*. |
| `CLOUDFLARE_ACCOUNT_ID`     | Any Cloudflare dashboard URL — the first path segment after `dash.cloudflare.com/<account-id>/`. Also visible in the Workers & Pages sidebar. |
| `PUBLIC_CF_ANALYTICS_TOKEN` | The Web Analytics beacon token (from Analytics & Logs → Web Analytics → the site). Public once deployed — still stored as a secret for convenience. |
| `PUBLIC_ADS_ENABLED`        | *(Optional)* — set to `placeholder` for dev preview stripes, `true` to render real AdSense. |
| `PUBLIC_ADSENSE_CLIENT`     | *(Optional)* — `ca-pub-…` from AdSense, only read when `PUBLIC_ADS_ENABLED=true`. |

### Manual deploy from your machine

Still works as a backup:

```bash
PUBLIC_CF_ANALYTICS_TOKEN=<token> npm run deploy
```

This runs `astro build && wrangler pages deploy ./dist`. Useful for emergency patches if GitHub Actions is down or you want to test a deploy locally before pushing.

## Project layout

```
src/
  layouts/BaseLayout.astro       — shell with SEO meta / JSON-LD / theme bootstrap script
  components/
    Header.astro, Footer.astro
    Hero.astro, ToolGrid.astro, TrustSection.astro
    PrivacyBadge.astro, HowItWorks.astro, Faq.astro, RelatedTools.astro, AdSlot.astro
    ToolHeader.astro
    tools/
      CompressVideoTool.astro    — UI + worker orchestration for /compress
  workers/
    encoder.worker.ts            — mp4box demux → WebCodecs → mp4-muxer mux pipeline
  lib/
    constants.ts                 — site name, URLs, sister-site list
    format.ts                    — bytes, duration, download helper
  pages/
    index.astro                  — landing
    compress.astro               — the compressor tool page
    about.astro
  styles/global.css              — design system + dark mode palette
public/
  favicon.svg, robots.txt, _headers (CSP + cache rules)
```

## Browser support

Tested on the latest Chrome / Edge (the most reliable), Safari 17.4+ on macOS / iOS / iPadOS, and Firefox where WebCodecs is enabled. Compression specifically requires:

- **WebCodecs API** with H.264 encode + decode support.
- **`File.stream()`** + `ReadableStream` for chunked file reading without loading the whole thing into RAM.
- **Web Worker module support** so the encoder pipeline runs off the main thread.

For multi-gigabyte sources, prefer desktop Chrome or Edge — they have the most stable WebCodecs implementations and benefit most from hardware acceleration.

## Privacy notes

- Site is a static bundle. **No backend, no upload endpoint.** The site's CSP enforces this: `connect-src 'self' https://cloudflareinsights.com;` browser-blocks any attempt to fetch elsewhere.
- No cookies. No service workers. **One** localStorage key: `theme` (light/dark mode preference, set by the toggle in the header). The About page discloses this honestly.
- No third-party scripts inside the tools. AdSense + Cloudflare Analytics, when enabled, render around the tools, never inside.
- `mp4box`, `mp4-muxer`, the encoder Worker — all bundled locally. No CDN fetches at runtime beyond the page's own static assets.
- Theme toggle uses one localStorage key; nothing about your files, nothing identifying.

## Dark mode

Themed via `[data-theme="dark"]` on `<html>`, set by an inline pre-paint init script in `BaseLayout.astro` (avoids flash-of-light). Reads the `theme` localStorage key on every page load; if absent, falls back to OS `prefers-color-scheme`.

The toggle button in the header cycles light ↔ dark and persists the choice. Half-shaded-moon (light → click to go dark) and outlined-sun (dark → click to go light) — same icon convention GNOME / KDE / macOS use.

## Ad slots

Every page has `<AdSlot />` placements. They're **off by default** — empty space, no third-party scripts, until you flip them on.

Three modes, set via `PUBLIC_ADS_ENABLED`:

| `PUBLIC_ADS_ENABLED`        | What renders                                                 |
| --------------------------- | ------------------------------------------------------------ |
| *(unset / anything else)*   | Nothing. An HTML comment marker remains so `<AdSlot />` positions are still greppable. **This is the launch-day default.** |
| `placeholder`               | Dashed stripes in each slot — useful for eyeballing layout during development or pre-launch. |
| `true`                      | Real Google AdSense. Also requires `PUBLIC_ADSENSE_CLIENT=ca-pub-…` and per-slot `slot` IDs added to the `<AdSlot />` calls in the pages. |

Every slot is tagged with a comment so they're easy to find:

```html
<!-- ADSENSE SLOT: compress-sidebar -->
```

## Analytics

Cloudflare Web Analytics is wired in — **cookieless, no consent banner needed**, injected only when `PUBLIC_CF_ANALYTICS_TOKEN` is set. CSP already whitelists the beacon host.

## License

MIT — see [LICENSE](./LICENSE).
