# Repository diagrams

The two editable Mermaid sources describe the collection pipeline and the separate collection/saved-data paths. Checked-in PNG images display without GitHub's interactive Mermaid renderer; SVG versions support full-size viewing. Their titles/descriptions are embedded in SVG, and the documentation supplies image alternative text and surrounding explanations.

## Local regeneration

Use the project's installed Node and Playwright Chromium prerequisites from [setup](../setup-verification.md). The renderer is optional documentation tooling; it does not change application dependencies, load `.env`, contact collectors or use an external rendering service.

Obtain the pinned tool in an isolated cache from the project root in PowerShell:

```powershell
New-Item -ItemType Directory -Force .cache/diagram-renderer | Out-Null
npm pack mermaid@12.2.0 --ignore-scripts --pack-destination .cache/diagram-renderer
tar -xzf .cache/diagram-renderer/mermaid-12.2.0.tgz -C .cache/diagram-renderer package/dist/mermaid.min.js
node scripts/render-diagrams.mjs --bundle .cache/diagram-renderer/package/dist/mermaid.min.js
node scripts/render-diagrams.mjs --bundle .cache/diagram-renderer/package/dist/mermaid.min.js --check
```

Tool acquisition contacts the npm registry. Rendering blocks browser requests and uses only the local bundle. Mermaid 12.2.0 is MIT-licensed; its official npm tarball integrity is `sha512-w7nr/SFrLO7BaVTs3dQTvYSV6nYSBj0Yy9DjBhsIJtAcHqRzXSq4Pg32ujHZ/AdWsAMNEvvhbm5dt9E2tOiHzw==`. The script rejects any bundle whose SHA256 differs from `a8a6a6f805b074a8261a2825c86f99c8054acb3b35f50bb7e24a4f9f2c3c3b9f`.

Edit the `.mmd` files or [shared configuration](mermaid-config.json), regenerate, review both image sizes and run `--check`. The check renders without writing and compares both SVG and PNG bytes. It also validates graph counts, accessible metadata, text bounds, image decoding and absence of active/external SVG content. Keep source semantics and expected counts aligned when deliberately changing a graph.

The verified environment uses Windows system fonts and the project's pinned Playwright/Chromium. Deterministic IDs and fixed configuration make repeat renders reproducible there. Fonts, operating systems and browser versions can change layout or PNG pixels; cross-platform byte identity is not promised. Regenerate and visually review on the intended toolchain before approving asset changes.
