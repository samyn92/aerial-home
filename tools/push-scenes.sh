#!/bin/sh
# Prepare the scenes listed in tools/scenes.tsv and copy them to the TV.
# Usage: TV=root@<tv-address> tools/push-scenes.sh
#
# Clips are cut to 60 s and re-encoded as 4K HEVC (~65 MB each) on this machine
# (needs ffmpeg with hevc_videotoolbox, i.e. macOS), then stored on the TV under
# /media/developer/aerial-home/scenes/ with their thumbnail, poster and the
# scenes.json list the app reads at start. That folder is outside the app, so
# reinstalls keep it, and nothing from the clips is bundled into the app.
set -eu

TV=${TV:?set TV=root@<tv-address>}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SSH="ssh -o BatchMode=yes -o ConnectTimeout=8 $TV"
OUT="$ROOT/media/scenes"
DEST=/media/developer/aerial-home/scenes

"$ROOT/tools/scenes.sh" "$ROOT/tools/scenes.tsv" "$OUT"
python3 "$ROOT/tools/build-data.py" >/dev/null # writes $OUT/scenes.json

put() { # <local file> <name on the TV>
  $SSH "cat > '$DEST/$2.part' && mv '$DEST/$2.part' '$DEST/$2'" <"$1"
}

$SSH "mkdir -p $DEST"
for clip in "$OUT"/*.mp4; do
  name=$(basename "$clip")
  if $SSH "[ -s '$DEST/$name' ]"; then
    echo "on TV: $name"
  else
    echo "copying $name"
    put "$clip" "$name"
  fi
done
for image in "$OUT"/*.jpg; do put "$image" "$(basename "$image")"; done
put "$OUT/scenes.json" scenes.json
$SSH "chmod -R a+rX /media/developer/aerial-home"
echo "Done. Aerial Home picks up the new list at its next start."
