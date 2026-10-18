"""Collect Apple's own preview images for the aerial scenes.

Usage: python3 tools/fetch-previews.py
Writes tools/catalog/previews.json ({scene id: image URL}). Apple publishes a
thumbnail per scene in the macOS and tvOS screensaver manifests; the app links
to them instead of shipping frames of the videos.
"""
import io
import json
import os
import plistlib
import tarfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MACOS_CONFIG = "https://configuration.apple.com/configurations/internetservices/aerials/resources-config-26-0.plist"
# tvOS has no discovery plist; this is the tvOS 26 manifest the Aerial projects use.
TVOS_TAR = "https://sylvan.apple.com/itunes-assets/Aerials126/v4/c0/45/d9/c045d9d0-9606-1535-62fe-189edb4f79eb/resources-atv-23J-2.tar"


def get(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read()


def entries(tar_url):
    with tarfile.open(fileobj=io.BytesIO(get(tar_url))) as tar:
        member = next(m for m in tar.getmembers() if os.path.basename(m.name) == "entries.json")
        return json.load(tar.extractfile(member))["assets"]


macos_tar = plistlib.loads(get(MACOS_CONFIG))["resources-url"]
previews = {}
for url in (TVOS_TAR, macos_tar):
    for a in entries(url):
        if a.get("previewImage", "").startswith("https://sylvan.apple.com/"):
            previews[a["id"].upper()] = a["previewImage"]

out = os.path.join(ROOT, "tools", "catalog", "previews.json")
with open(out, "w") as f:
    json.dump(dict(sorted(previews.items())), f, indent=1)
print(f"{out}: {len(previews)} previews")
