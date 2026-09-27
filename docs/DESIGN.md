# Assay — the page

**One page, two skins, both in Gryps's design language.** A cream light skin and a near-black dark skin.
Neither is an inversion of the other: every colour is a named token, mapped one-for-one between the two.

| role | light | dark | token |
|---|---|---|---|
| ground | `#f2eee3` | `#0e0e10` | `surface-inverse` / `surface-0` |
| panel | `#f7f4ec` | `#16161a` | — / `surface-1` |
| ink | `#292722` · strong `#16150f` | `#e2e2e7` · strong `#f4f4f6` | `text-on-inverse` / `text-strong` |
| hairline | `rgba(41,39,34,.13)` | `rgba(255,255,255,.11)` | `hairline` |
| accent (selection, curve) | `#3b55c9` | `#9db0f8` | `on-inverse-accent` / `accent` |
| **economic** (tradeable) | `#0a6b34` | `#57d392` | `on-inverse-success` / `success` |
| **fail-economic** (priced out) | `#b8720a` † | `#e3b45b` | `on-inverse-warn` / `warn` |
| **fail-signal** (inert) | `#7d7970` | `#8e8e99` | neutral by design |
| brand gradient | coral `#eaaba0` → purple `#b79bf3` → periwinkle `#9db0f8` | same | `brand-*` |

† The cream-mode warn token (`#7a5200`) sits 4.9 ΔE from the success green under
deutan simulation. The two verdicts it separates are the ones the page argues are
*different*, so it is shifted to `#b8720a` (9.3 ΔE, contrast ≥ 3:1). Every verdict
is also labelled in words; colour is never the only carrier.

**Type.** Switzer 400/500/600 (Fontshare, ITF Free Font License) is inlined as
data URIs so the page renders identically on claude.ai, GitHub Pages, from disk,
and inside the Next.js build — the artifact host blocks Fontshare's CDN.
JetBrains Mono from Google Fonts carries every number, eyebrow, table and payload.
Display is 600 at −0.028em; eyebrows are 11px uppercase at .13em.

**Grammar.** Sections are an eyebrow with a hairline running out to the right and
nothing else. Figures are hairline-topped stat tiles. Tables have a tinted header
band. Only two things are boxed: the gradient verdict band (carrying the live
tally at the current cost) and the instrument, where the slider and the break-even rail share one x-scale and one
cursor.

**State.** `?cost=90&cohort=Fund&h=168` restores an exact frame, so a moment is a
link. An absent parameter is absent, not zero.

## Embedding the page in your own site

- **As a route**: drop `page.body.html`'s markup and script into a page component;
  its `<style>` block is self-scoped by class and its tokens override cleanly under
  your `:root`. Delete the inlined `@font-face` rules when your site already loads
  Switzer.
- **As a section**: the verdict band + three tiles + the matrix are the unit. Give
  them the section's `sweep.json` and keep `#cost`, `#t-econ`, `#t-costly`,
  `#t-dead`, `.cell[data-v]`; that is what `docs/verify.mjs` checks against the
  engine.
- **Data**: `sweep.json` is produced from the engine's own output, one frame per
  cost. The page renders it and computes no verdict of its own; `docs/verify.mjs`
  drives the built page in a real browser and diffs every cell against the engine
  at eight costs, in both themes.

## Build

```
node docs/build.mjs                  # page.src.html + fonts -> index.html (the study), check.html (the instrument check), artifact.html
node docs/verify.mjs --study         # the study page against ledger/study/verdicts.json and the audit file; no fixtures needed
npm run fixtures && npm run verify:docs   # both pages; the check against the engine re-run from the seeded fixtures
```

`page.src.html` is the one editable source, with a `/*__SWITZER__*/` placeholder the build fills from
`fonts.switzer.css` (`page.body.html` is that step's output). The page reads its mode from its data: a sweep with a
planted ground truth is the instrument check, anything else is the study. The study page inlines
`ledger/study/sweep.json` and a summary of `ledger/study/convention-audit.json`; the check inlines `docs/sweep.json`.
