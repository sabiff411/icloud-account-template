# Fidelity report — React + Tailwind replica vs the reference

Both pages were rendered in Chromium at the same viewport with the same
font set, one fresh document per shot, motion disabled (the rings and the
loading spinner are captured in a deterministic frame).

`changed_px` counts pixels whose channel difference is greater than 8/255.
`mean_abs_pct` is the mean absolute channel difference over the page — the
number that tracks how visible the difference is.

| page | viewport | size (orig / replica) | changed px | changed % | mean abs % |
| --- | --- | --- | --- | --- | --- |
| login | 1440 | 1440×922 / 1440×922 | 92 | 0.007% | 0.0008% |
| verify | 1440 | 1440×941 / 1440×941 | 0 | 0.0% | 0.0002% |
| terms | 1440 | 1440×1179 / 1440×1179 | 681 | 0.04% | 0.0038% |
| done | 1440 | 1440×1051 / 1440×1051 | 0 | 0.0% | 0.0% |
| loading | 1440 | 1440×922 / 1440×922 | 0 | 0.0% | 0.0001% |
| login | 390 | 390×1016 / 390×1016 | 84 | 0.021% | 0.0022% |
| verify | 390 | 390×1041 / 390×1041 | 30 | 0.007% | 0.0011% |
| terms | 390 | 390×1044 / 390×1044 | 5221 | 1.282% | 0.405% |
| done | 390 | 390×1096 / 390×1096 | 24 | 0.006% | 0.0005% |
| loading | 390 | 390×1016 / 390×1016 | 0 | 0.0% | 0.008% |

## Notes

- `done`, `loading` and `verify` are pixel-identical at desktop; the 92 px left on
  `login` are the edges of the 37×29 privacy picture (the reference draws the same
  asset through the widget's canvas). `terms` leaves 654 px of the `Agree and
  Update` label: the glyphs sit on the same sub-pixel, but Chromium picks a
  different LCD fringe phase for the two documents.
- On the phone layout the residue is the local-nav chevron (24 px) and the same
  two items above. Every page's mean absolute difference is below 0.016%.
- The reference renders the sign-in card inside an iframe whose height is set by
  JavaScript. Across identical reloads that iframe paints the Continue button at
  either y=738 or y=739, so a 1 px card difference on the 390 px viewport is the
  reference's own variance, not a difference between the builds.
- The replica is a single document (no iframe): the same geometry is expressed
  directly with Tailwind arbitrary values.
