"""Package app/ as a webOS IPK.

Usage: python3 tools/build-ipk.py            -> build/io.aerialhome_<version>_all.ipk

Writes the same layout ares-package produces: an ar archive holding
debian-binary, control.tar.gz and data.tar.gz, with tar member names that have
no "./" prefix and real modification times (some TVs reject 1970 dates).
"""
import gzip
import hashlib
import io
import json
import os
import tarfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "app")
REPO_URL = "https://github.com/samyn92/aerial-home"
REPO_RAW = "https://raw.githubusercontent.com/samyn92/aerial-home"
NOW = int(time.time())
EXECUTABLE = (".sh",)
EXECUTABLE_NAMES = ("50-aerialhome",)


def tar_gz(entries):
    """entries: list of (name, bytes or None for a directory, mode)."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.GNU_FORMAT) as tar:
        for name, data, mode in entries:
            info = tarfile.TarInfo(name)
            info.mtime = NOW
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            info.mode = mode
            if data is None:
                info.type = tarfile.DIRTYPE
                tar.addfile(info)
            else:
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", mtime=NOW) as gz:
        gz.write(raw.getvalue())
    return out.getvalue()


def ar(members):
    """members: list of (name, bytes). BSD-style names, as in ares-package output."""
    out = io.BytesIO()
    out.write(b"!<arch>\n")
    for name, data in members:
        header = (
            name.ljust(16)
            + str(NOW).ljust(12)
            + "0".ljust(6)
            + "0".ljust(6)
            + "100644".ljust(8)
            + str(len(data)).ljust(10)
            + "`\n"
        )
        out.write(header.encode("ascii"))
        out.write(data)
        if len(data) % 2:
            out.write(b"\n")
    return out.getvalue()


def main():
    info = json.load(open(os.path.join(APP, "appinfo.json")))
    app_id, version = info["id"], info["version"]
    app_prefix = "usr/palm/applications/" + app_id
    pkg_prefix = "usr/palm/packages/" + app_id

    entries = []
    for d in ("usr", "usr/palm", "usr/palm/applications", "usr/palm/packages", app_prefix, pkg_prefix):
        entries.append((d + "/", None, 0o755))
    size = 0
    for dirpath, dirnames, filenames in sorted(os.walk(APP)):
        dirnames.sort()
        rel = os.path.relpath(dirpath, APP)
        if rel != ".":
            entries.append((app_prefix + "/" + rel + "/", None, 0o755))
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            data = open(os.path.join(dirpath, name), "rb").read()
            size += len(data)
            mode = 0o755 if name.endswith(EXECUTABLE) or name in EXECUTABLE_NAMES else 0o644
            path = app_prefix + "/" + (name if rel == "." else rel + "/" + name)
            entries.append((path, data, mode))
    packageinfo = json.dumps({"id": app_id, "version": version, "app": app_id}, indent=2).encode()
    entries.append((pkg_prefix + "/packageinfo.json", packageinfo, 0o644))

    control = (
        "Package: {id}\nVersion: {v}\nSection: misc\nPriority: optional\nArchitecture: all\n"
        "Installed-Size: {size}\nMaintainer: Aerial Home\nDescription: {desc}\n"
        "webOS-Package-Format-Version: 2\nwebOS-Packager-Version: x.y.x\n"
    ).format(id=app_id, v=version, size=size, desc=info.get("appDescription", app_id)).encode()

    ipk = ar([
        ("debian-binary", b"2.0\n"),
        ("control.tar.gz", tar_gz([("control", control, 0o644)])),
        ("data.tar.gz", tar_gz(entries)),
    ])
    os.makedirs(os.path.join(ROOT, "build"), exist_ok=True)
    out = os.path.join(ROOT, "build", "{}_{}_all.ipk".format(app_id, version))
    open(out, "wb").write(ipk)
    print("{} ({} KB, {} files)".format(out, len(ipk) // 1024, sum(1 for e in entries if e[1] is not None)))

    # The Homebrew Channel's package manifest, published next to the IPK in each release.
    manifest = {
        "id": app_id,
        "version": version,
        "type": info.get("type", "web"),
        "title": info.get("title", app_id),
        "appDescription": info.get("appDescription", ""),
        "iconUri": REPO_RAW + "/main/docs/icon160.png",
        "sourceUrl": REPO_URL,
        "rootRequired": True,
        "ipkUrl": os.path.basename(out),
        "ipkHash": {"sha256": hashlib.sha256(ipk).hexdigest()},
    }
    with open(os.path.join(ROOT, "build", app_id + ".manifest.json"), "w") as f:
        json.dump(manifest, f)


if __name__ == "__main__":
    main()
