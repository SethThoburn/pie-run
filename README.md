# Pie Run — Deary, Idaho

A top-down pixel-art motorcycle time trial through the real town of Deary, Idaho.
Ride from 704 5th Ave to The Pie Safe and back home as fast as you can.

Play: open `index.html` (no build step; runs from any static host).

## Map data
- Streets and mapped buildings: © OpenStreetMap contributors (ODbL) — `tools/build-map.mjs`
- Ground colours, tree cover, rooftops: USGS The National Map, NAIP Plus imagery (public domain) — `tools/build-sat.mjs`

Rebuild data:
```
node tools/build-map.mjs
tools/imagery/fetch.sh && node tools/build-sat.mjs
```
