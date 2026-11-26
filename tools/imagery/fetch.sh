#!/bin/sh
# Downloads USGS NAIP Plus orthoimagery (public domain, USGS The National Map) of
# Deary, Idaho, aligned exactly to the game world grid (same bbox as build-map.mjs).
# ArcGIS stretches the bbox to the image aspect ratio, so request in degree aspect
# (0.0195 x 0.0120 deg = 1.625) and resample to the 2977x2668 world grid afterwards.
set -e
cd "$(dirname "$0")"
URL="https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage?bbox=-116.5675,46.7940,-116.5480,46.8060&bboxSR=4326&imageSR=4326&size=4000,2462&format=png&interpolation=RSP_BilinearInterpolation&f=image"
curl -sf -m 300 -o raw.png "$URL"
magick raw.png -filter Lanczos -resize '2977x2668!' -alpha off deary-naip.png
rm raw.png
echo "wrote deary-naip.png"
