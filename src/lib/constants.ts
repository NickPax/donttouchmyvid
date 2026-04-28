// Single source of truth for site-wide strings.
// Same scheme as the sibling sites — one place to update if URLs / branding move.

export const SITE_NAME = 'DontTouchMyVid';
export const SITE_URL = 'https://donttouchmyvid.com';
export const SITE_TAGLINE = 'Video tools that actually respect your footage.';

// NOTE: assumes the same GitHub owner as the sibling repos (NickPax).
// Update once the repo actually exists.
export const GITHUB_REPO = 'https://github.com/NickPax/donttouchmyvid';

export const SIBLING_SITES = [
  { name: 'DontTouchMyDoc', url: 'https://donttouchmydoc.com', blurb: 'PDF tools that never upload.' },
  { name: 'DontTouchMyPic', url: 'https://donttouchmypic.com', blurb: 'Image tools that never upload.' },
] as const;
