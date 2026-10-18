#!/bin/sh
# Prepare launcher scenes: a 60 s 4K HEVC clip, a small thumbnail and a full-size
# poster of the first frame per entry (the poster bridges the switch between clips).
# Usage: scenes.sh scenes.tsv <outdir>   (tsv: slug<TAB>title<TAB>url-or-path)
set -eu

TSV=$1
OUT=$2
SECONDS_PER_CLIP=${SECONDS_PER_CLIP:-60}
mkdir -p "$OUT"
cd "$(dirname "$TSV")"

while IFS="$(printf '\t')" read -r slug title src; do
  [ -n "$slug" ] || continue
  if [ ! -s "$OUT/$slug.mp4" ]; then
    echo "== $slug ($title)"
    ffmpeg -hide_banner -loglevel error -y -t "$SECONDS_PER_CLIP" -i "$src" -an \
      -vf "format=yuv420p" \
      -c:v hevc_videotoolbox -b:v 9M -maxrate 14M -bufsize 20M -tag:v hvc1 \
      -color_primaries bt709 -color_trc bt709 -colorspace bt709 \
      -movflags +faststart "$OUT/$slug.mp4" </dev/null
  fi
  ffmpeg -hide_banner -loglevel error -y -ss 8 -i "$OUT/$slug.mp4" -frames:v 1 \
    -vf "scale=384:216" -q:v 4 "$OUT/$slug.jpg" </dev/null
  ffmpeg -hide_banner -loglevel error -y -i "$OUT/$slug.mp4" -frames:v 1 \
    -vf "scale=1920:1080:flags=lanczos" -q:v 3 "$OUT/$slug-poster.jpg" </dev/null
  printf '%s\t%s\t%s\n' "$slug" "$title" "$(stat -f %z "$OUT/$slug.mp4")"
done < "$TSV"
