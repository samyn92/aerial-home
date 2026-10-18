#!/bin/sh
# Render tools/art/ into the app's icons and splash screen.
# Usage: CHROME=/path/to/chrome-or-headless-shell tools/render-art.sh
# Needs a Chromium build (Chrome, or Playwright's chrome-headless-shell) and ffmpeg.
set -eu

CHROME=${CHROME:?set CHROME to a Chromium or chrome-headless-shell binary}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ART="$ROOT/tools/art"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

shot() { # <file> <width> <height> <out.png>
  "$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size="$2,$3" --screenshot="$4" "file://$1" >/dev/null 2>&1
}

# The icon is drawn at 160 px; render it large and scale down for clean edges.
printf '<!doctype html><style>html,body{margin:0;background:#000}img{display:block;width:640px;height:640px}</style><img src="%s">' \
  "file://$ART/icon.svg" >"$TMP/icon.html"
shot "$TMP/icon.html" 640 640 "$TMP/icon640.png"
ffmpeg -hide_banner -loglevel error -y -i "$TMP/icon640.png" -vf scale=80:80:flags=lanczos "$ROOT/app/icon.png"
ffmpeg -hide_banner -loglevel error -y -i "$TMP/icon640.png" -vf scale=130:130:flags=lanczos "$ROOT/app/largeIcon.png"
ffmpeg -hide_banner -loglevel error -y -i "$TMP/icon640.png" -vf scale=160:160:flags=lanczos "$ROOT/docs/icon160.png"

# README icon: the same artwork clipped to a rounded square, with a hairline edge
# so it holds on dark pages.
{
  sed -e 's#width="160" height="160"#width="512" height="512"#' -e '/<\/defs>/,$d' "$ART/icon.svg"
  printf '    <clipPath id="round">\n      <rect x="16" y="38" width="128" height="128" rx="29"/>\n    </clipPath>\n  </defs>\n  <g clip-path="url(#round)">\n'
  sed -e '1,/<\/defs>/d' -e '/<\/svg>/d' "$ART/icon.svg"
  printf '  </g>\n  <rect x="16.4" y="38.4" width="127.2" height="127.2" rx="28.6" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width=".8"/>\n</svg>\n'
} >"$ROOT/docs/icon.svg"

# Splash: the landscape without the dock, cropped to 16:9.
sed -e '/<g id="dock">/,/<\/g>/d' \
  -e 's#viewBox="16 38 128 128" width="160" height="160"#viewBox="0 44 160 90" width="1920" height="1080" preserveAspectRatio="xMidYMid slice"#' \
  "$ART/icon.svg" >"$TMP/land.svg"
cp "$ART/splash.html" "$TMP/splash.html"
cp "$ROOT/app/assets/inter-latin-wght.woff2" "$TMP/inter.woff2"
shot "$TMP/splash.html" 1920 1080 "$TMP/splash.png"
ffmpeg -hide_banner -loglevel error -y -i "$TMP/splash.png" -q:v 3 "$ROOT/app/splash.jpg"
echo "rendered app/icon.png, app/largeIcon.png, docs/icon160.png, docs/icon.svg, app/splash.jpg"
