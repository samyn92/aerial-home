#!/bin/sh
# Build Aerial Home and install it on a rooted webOS TV over SSH.
# Usage: TV=root@<tv-address> tools/deploy.sh
set -eu

TV=${TV:?set TV=root@<tv-address>}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SSH="ssh -o BatchMode=yes -o ConnectTimeout=8 $TV"

python3 -I "$ROOT/tools/build-data.py"
IPK=$(python3 -I "$ROOT/tools/build-ipk.py" | awk '{print $1}')
NAME=$(basename "$IPK")

echo "== copying $NAME"
$SSH "mkdir -p /media/developer/temp && cat > /media/developer/temp/$NAME" <"$IPK"

echo "== installing"
# The install reports progress over a subscription. luna-send -i exits when its stdin
# closes, so feed it a sleep, log in the background, and stop at the final status
# (30 = installed) instead of waiting out the timeout. The background luna-send ends
# on its own timeout; don't pkill it by pattern, since that pattern is also in this
# shell's own command line and would kill the shell.
$SSH "LOG=/tmp/aerialhome-install.log
(sleep 120 | timeout -t 110 luna-send -i luna://com.webos.appInstallService/dev/install \
  '{\"id\":\"io.aerialhome\",\"ipkUrl\":\"/media/developer/temp/$NAME\",\"subscribe\":true}' >\$LOG 2>&1 &)
i=0
while [ \$i -lt 110 ] && ! grep -q -E '\"statusValue\":30|errorCode|\"failed\"' \$LOG 2>/dev/null; do i=\$((i + 1)); sleep 1; done
rm -f /media/developer/temp/$NAME
if grep -q '\"statusValue\":30' \$LOG; then echo \"installed in \${i}s\"; else echo 'install failed:'; tail -3 \$LOG; exit 1; fi" 2>&1 |
  grep -v -i -E "post-quantum|store now|upgraded|pq.html" | cut -c1-200

echo "== launching"
$SSH 'luna-send -n 1 luna://com.webos.applicationManager/launch "{\"id\":\"io.aerialhome\"}" </dev/null'
echo
