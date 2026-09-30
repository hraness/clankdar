# Clankdar website identity

The favicon silhouette comes from the actual header mark, `marks/clankdar.svg`. Browser variants render it in pure white on transparency. Apple touch variants use the same white mark on black. The visible bounds are centered horizontally and vertically and fill the square on their longest axis, preserving the aspect ratio with no added padding.

Run `bun site/generate-icon-512.ts` with provisioned pinned Playwright Chromium to regenerate every variant. The historical Python command delegates to that same guarded renderer.

| File | Size | SHA-256 |
| --- | --- | --- |
| marks/clankdar.svg | SVG | `12e321d88ec806e138b54ec2f00a605784486c26800d82c38c06a1ae0073efff` |
| icon.png | 32×32 | `a95c2e6e6166a0b77c586a5ab75fb25c7444ec39869a03e5c58a77026d1128cf` |
| icon-512.png | 512×512 | `bab2f0767248571c98a84a0009cbf2909c74db80944563ee8fda0363c1eff337` |
| apple-icon.png | 180×180 | `bb737408ccca48c5f15d80e03c13f1757e03591381ba7e289595724a308f61ac` |
| favicon.svg | SVG | `97a4818af7593d3d18e9b66826cc192b4de27200333f67265af38d3cfb8b0579` |

Share images are not checked in. The build renders `/og.png` and every
`/og/…` card from the shared `@hraness/web-discovery` social-image template,
using the one site declaration in `social.ts` and the radar-dish mark in
`marks/clankdar.svg`.

## Hraness network footer mark

`marks/hraness.svg` is the exact inline Ra artwork rendered by immutable `@hraness/site-footer` v0.20.1 (`60d6ba5baad35f4a7abdc6fe2e693ddd7bf00476`), extracted as a same-origin mask so the existing image CSP remains intact. SHA-256: `fd4f6259d35372f5896c72d51bf40582a8509386ff0a3e47e68cf511b82ef9ef`.
