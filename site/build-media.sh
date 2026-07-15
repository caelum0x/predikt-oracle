#!/usr/bin/env bash
# Copies the rendered demo videos + posters into site/media/ before deploy.
set -e
cd "$(dirname "$0")"
mkdir -p media
cp ../submission/demo-video/*.mp4 media/
cp ../submission/demo-video/posters/*.png media/
echo "media ready ($(ls media | wc -l | tr -d ' ') files)"
