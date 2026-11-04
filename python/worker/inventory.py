"""Read-only profile and inventory snapshot.

Every service is guarded: one unavailable webservice must not fail the login
or the export.  Counts are intentionally cheap; the exporter does the heavy
enumeration separately.
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger("worker.inventory")


def _safe(label: str, fn, default=None):
    try:
        return fn()
    except Exception as error:
        log.info("%s unavailable: %s", label, type(error).__name__)
        return default


def _plan(storage, summary) -> dict:
    plan = {}
    if isinstance(summary, dict):
        plan["featureKey"] = summary.get("featureKey", "")
        plan["summary"] = summary.get("summary", {})
    if storage is not None:
        plan["used"] = getattr(storage, "used_storage_in_bytes", None)
        plan["total"] = getattr(storage, "total_storage_in_bytes", None)
        plan["percent"] = getattr(storage, "used_storage_in_percent", None)
        plan["tierMax"] = getattr(storage, "quota_tier_max", None)
    return plan


def _contact_stats(contacts: list[dict]) -> tuple[int, int]:
    with_phone = 0
    with_email = 0
    for contact in contacts or []:
        if contact.get("phones"):
            with_phone += 1
        if contact.get("emails"):
            with_email += 1
    return with_phone, with_email


def _drive_counts(root) -> tuple[int, int]:
    files = 0
    total = 0
    stack = [root]
    seen = set()
    while stack:
        node = stack.pop()
        key = getattr(node, "name", "") + "|" + str(getattr(node, "size", ""))
        if key in seen:
            continue
        seen.add(key)
        children = _safe("drive children", lambda n=node: n.get_children(), []) or []
        for child in children:
            if getattr(child, "type", "") == "folder":
                stack.append(child)
            else:
                files += 1
                try:
                    total += int(getattr(child, "size", 0) or 0)
                except (TypeError, ValueError):
                    pass
    return files, total


def collect(api) -> dict[str, Any]:
    identity: dict[str, Any] = {
        "name": "",
        "phone": "",
        "plan": {},
        "storage": {},
        "family": [],
        "devices": [],
    }
    counts: dict[str, int] = {
        "photos": 0,
        "hidden": 0,
        "deleted": 0,
        "notes": 0,
        "albums": 0,
        "contacts": 0,
        "contactsPhone": 0,
        "contactsEmail": 0,
        "driveFiles": 0,
        "driveBytes": 0,
        "reminders": 0,
        "calendars": 0,
    }

    account = getattr(api, "account", None)
    if account is not None:
        storage = _safe("account.storage", lambda: api.account.storage)
        summary = _safe("account.summary_plan", lambda: api.account.summary_plan, {})
        identity["plan"] = _plan(storage, summary)
        identity["storage"] = {
            "used": getattr(storage, "used_storage_in_bytes", None) if storage else None,
            "total": getattr(storage, "total_storage_in_bytes", None) if storage else None,
        }
        family = _safe("account.family", lambda: api.account.family, []) or []
        identity["family"] = [
            getattr(member, "full_name", "") or getattr(member, "apple_id", "")
            for member in family
        ]
        devices = _safe("account.devices", lambda: api.account.devices, []) or []
        identity["devices"] = [
            getattr(device, "name", "") or getattr(device, "model", "") or "device"
            for device in devices
        ]

    me = _safe("contacts.me", lambda: api.contacts.me)
    if me is not None:
        identity["name"] = " ".join(
            part for part in [getattr(me, "first_name", ""), getattr(me, "last_name", "")] if part
        ) or str(me)
        raw = getattr(me, "raw_data", {}) or {}
        phones = raw.get("phones") or []
        if phones:
            first = phones[0]
            identity["phone"] = first.get("field", "") if isinstance(first, dict) else str(first)

    contacts = _safe("contacts.all", lambda: api.contacts.all, []) or []
    counts["contacts"] = len(contacts)
    counts["contactsPhone"], counts["contactsEmail"] = _contact_stats(contacts)

    photos = getattr(api, "photos", None)
    if photos is not None:
        counts["photos"] = _safe("photos.all", lambda: len(api.photos.all), 0) or 0
        counts["albums"] = _safe("photos.albums", lambda: len(api.photos.albums), 0) or 0
        counts["hidden"] = _safe(
            "photos.hidden", lambda: len(api.photos.albums["Hidden"]), 0
        ) or 0
        counts["deleted"] = _safe(
            "photos.deleted", lambda: len(api.photos.albums["Recently Deleted"]), 0
        ) or 0

    notes = getattr(api, "notes", None)
    if notes is not None:
        summaries = _safe("notes.iter_all", lambda: list(api.notes.iter_all()), []) or []
        counts["notes"] = sum(1 for note in summaries if not getattr(note, "is_deleted", False))

    drive = getattr(api, "drive", None)
    if drive is not None:
        counts["driveFiles"], counts["driveBytes"] = _drive_counts(api.drive.root)

    reminders = getattr(api, "reminders", None)
    if reminders is not None:
        lists = _safe("reminders.lists", lambda: list(api.reminders.lists()), []) or []
        total = 0
        for reminders_list in lists:
            try:
                result = api.reminders.list_reminders(
                    reminders_list.id, include_completed=True
                )
                total += len(getattr(result, "reminders", []) or [])
            except Exception:
                pass
        counts["reminders"] = total

    calendar = getattr(api, "calendar", None)
    if calendar is not None:
        calendars = _safe("calendar.get_calendars", lambda: calendar.get_calendars(), []) or []
        counts["calendars"] = len(calendars)

    return {"identity": identity, "counts": counts}
