#!/usr/bin/env python3
"""Probe a CloudKit container with an authenticated iCloud web session.

Useful for features pyicloud does not wrap (for example Voice Memos:
``--container com.apple.VoiceMemosContainer``). It is read-only by default and
prints zones, record types, record names, field names and asset sizes. With
``--download DIR`` it also streams every asset it can find.

The account must already be able to use the container; a 401 / ZONE_NOT_FOUND
means the web session is not entitled to it. Nothing here writes to iCloud.

    python probe_container.py --email me@example.com \
        --session-dir ~/.local/share/pyicloud-probe \
        --container com.apple.VoiceMemosContainer --download ./voice-memos
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import sys

from pyicloud import PyiCloudService
from pyicloud.common.cloudkit import (
    CKAssetToken,
    CKRecord,
    CKZoneChangesZoneReq,
    CKZoneIDReq,
)
from pyicloud.common.cloudkit.client import CloudKitContainerClient
try:                                            # main
    from pyicloud.services.photos.mappers import (
        record_field_value, record_name,
    )
except ImportError:                             # 2026.10.1
    from pyicloud.services.photos_cloudkit.mappers import (
        record_field_value, record_name,
    )


def safe(value: str) -> str:
    value = re.sub(r'[\x00-\x1f<>:"/\\|?*]', "_", value)
    return value.strip(" .")[:120] or "unnamed"


def login(args: argparse.Namespace) -> PyiCloudService:
    session_dir = Path(args.session_dir).expanduser()
    session_dir.mkdir(parents=True, exist_ok=True)

    # Password-free preflight: no SRP, no device notification.
    api = PyiCloudService(args.email, cookie_directory=str(session_dir),
                           authenticate=False)
    status = api.get_auth_status()
    if status["authenticated"] and status["trusted_session"]:
        return api

    password = args.password or os.environ.get("ICLOUD_PASSWORD")
    if password is None:
        password = getpass.getpass("Apple account password: ")
    api = PyiCloudService(
        args.email,
        password,
        cookie_directory=str(session_dir),
    )
    if api.requires_2fa:
        code = input(f"2FA code ({api.two_factor_delivery_method}): ").strip()
        if not api.validate_2fa_code(code):
            raise SystemExit("2FA rejected")
        if not api.is_trusted_session and not api.trust_session():
            print("warning: session not trusted; next run will ask again",
                  file=sys.stderr)
    elif api.requires_2sa:
        devices = api.trusted_devices or []
        for index, device in enumerate(devices):
            print(index, device.get("deviceName")
                  or device.get("phoneNumber") or "destination")
        index = int(input("destination: "))
        device = devices[index]
        if not api.send_verification_code(device):
            raise SystemExit("could not send code")
        if not api.validate_verification_code(device, input("code: ").strip()):
            raise SystemExit("2SA rejected")
    return api


def asset_url(value: object) -> str | None:
    if isinstance(value, CKAssetToken):
        return value.downloadURL
    if isinstance(value, dict):
        return value.get("downloadURL")
    return getattr(value, "downloadURL", None)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", help="or ICLOUD_PASSWORD / prompt")
    parser.add_argument("--session-dir", default="~/.local/share/pyicloud-probe")
    parser.add_argument("--container", default="com.apple.VoiceMemosContainer")
    parser.add_argument("--env", default="production")
    parser.add_argument("--scope", default="private")
    parser.add_argument("--download", type=Path)
    parser.add_argument("--max-records", type=int, default=0,
                        help="0 = no limit")
    args = parser.parse_args()

    api = login(args)
    try:
        base = (api.get_webservice_url("ckdatabasews").rstrip("/")
                + f"/database/1/{args.container}/{args.env}/{args.scope}")
        client = CloudKitContainerClient(base, api.session, api.params)
        zones = client.zones_list().zones
        print(json.dumps({
            "container": args.container,
            "env": args.env,
            "scope": args.scope,
            "zones": [z.zoneID.zoneName for z in zones if not z.deleted],
        }, indent=2))

        if args.download:
            args.download.mkdir(parents=True, exist_ok=True)

        seen = 0
        for zone in zones:
            if zone.deleted:
                continue
            req = CKZoneChangesZoneReq(
                zoneID=CKZoneIDReq(**zone.zoneID.model_dump()),
                syncToken=None,
                reverse=False,
            )
            for change in client.iter_changes(zone_req=req):
                for record in change.records:
                    if not isinstance(record, CKRecord):
                        print(f"tombstone zone={zone.zoneID.zoneName}")
                        continue
                    seen += 1
                    print(f"\n{record.recordType} {record.recordName} "
                          f"zone={zone.zoneID.zoneName}")
                    for key in record.fields.keys():
                        value = record_field_value(record, key)
                        url = asset_url(value)
                        if url:
                            size = getattr(value, "size", None)
                            if isinstance(value, dict):
                                size = value.get("size")
                            print(f"  {key}: ASSET size={size}")
                            if args.download:
                                target = args.download / safe(
                                    f"{record.recordName}-{key}"
                                )
                                with target.open("wb") as stream:
                                    for chunk in client.download_asset_stream(url):
                                        stream.write(chunk)
                                print(f"    saved {target} "
                                      f"({target.stat().st_size} bytes)")
                        else:
                            text = repr(value)
                            print(f"  {key}: {text[:160]}")
                    if args.max_records and seen >= args.max_records:
                        print(f"\nstopped after {seen} records")
                        return 0
        print(f"\nrecords: {seen}")
    finally:
        api.session.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
