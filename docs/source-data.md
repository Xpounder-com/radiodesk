# Embedded source data

## Natural Earth land polygons

- Local file: `src/propagation/land.json`
- Dataset: Natural Earth physical land, 1:110 million scale.
- Source repository: [nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector).
- Exact asset URL: [ne_110m_land.geojson](https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson).
- Downloaded: 2026-10-12 UTC.
- Asset size: 138,160 bytes; 127 polygon features; 5,143 vertices.
- SHA-256: `9e0729ee253ca7d7a5c4ae9395fb1902264c5377c52e224d13dd85010e2835d9`.
- License: **Public domain**, independently confirmed from [Natural Earth's official Terms of Use](https://www.naturalearthdata.com/about/terms-of-use/). The terms permit modification, electronic distribution and commercial use, without requiring permission or attribution.

The file is the unmodified source GeoJSON, renamed to `.json` for a static build-time import. RadioDesk embeds it into the distribution HTML and does not fetch map data at runtime. The map UI credits Natural Earth voluntarily. It draws the land layer under calculated daylight shading, grid lines, the geometric solar boundary and station paths.
