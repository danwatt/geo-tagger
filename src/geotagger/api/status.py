"""Status, live-tunable settings, and debug endpoints."""

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from geotagger import index, geocode, config
from geotagger.exiftool_session import exiftool_status

router = APIRouter()


class UpdateSettingsRequest(BaseModel):
    # {setting_key: new_value}; ints/bools are coerced server-side per SETTINGS_SPEC.
    values: dict[str, float | bool]

class ResetSettingsRequest(BaseModel):
    keys: list[str]


# Response models: these describe the JSON in the OpenAPI schema, which the React
# frontend turns into TypeScript types (frontend/src/api/schema.d.ts). `bool | int |
# float` order matters: pydantic's smart union keeps an exact type match, so ints
# stay ints (14400, not 14400.0) and bools stay bools.
SettingValue = bool | int | float


class SettingOut(BaseModel):
    key: str
    type: Literal["bool", "int", "float"]
    group: str
    label: str
    help: str
    min: float | None = None
    max: float | None = None
    step: float | None = None
    value: SettingValue
    default: SettingValue
    overridden: bool


class SettingsResponse(BaseModel):
    settings: list[SettingOut]


class UpdateSettingsResponse(BaseModel):
    updated: dict[str, SettingValue]


class ResetSettingsResponse(BaseModel):
    reset: list[str]


class ScanStatusResponse(BaseModel):
    """scanning._blank_state()'s keys. Keep in step with it."""
    running: bool
    root: str | None
    phase: Literal["counting", "indexing", "geocoding", "pruning"] | None
    processed: int
    total: int
    indexed: int
    skipped: int
    known_failed: int
    warnings: int
    errors: int
    error: str | None
    summary: str | None
    started_at: float | None
    finished_at: float | None


class ScanErrorOut(BaseModel):
    path: str
    dir: str
    filename: str
    stage: Literal["stat", "read", "write"]
    error: str
    first_seen: float
    last_seen: float
    attempts: int


class ScanErrorsResponse(BaseModel):
    count: int
    errors: list[ScanErrorOut]
    warnings: list[str]


class ClearScanErrorsResponse(BaseModel):
    cleared: int


@router.get("/api/status")
async def api_status():
    """Component health. A component being unavailable (ExifTool missing, no
    GeoNames data) is a normal, reportable state: 200 with that component's
    ``available: false`` + ``reason``. The DB is not optional — without it
    nothing works — so a failing COUNT is a 503, never a 200 whose ``db_total``
    is an error string (audit A12: that made `res.ok` lie)."""
    try:
        total = index.get_db().execute("SELECT COUNT(*) FROM photos").fetchone()[0]
    except Exception as e:
        raise HTTPException(503, f"Database unavailable: {e}")
    et = exiftool_status()
    return {
        "exiftool": {"available": et["ok"], "reason": et.get("error")},
        "db_total": total,
        "geocoder": geocode.status(),
    }


@router.get("/api/scan/status", response_model=ScanStatusResponse)
async def api_scan_status():
    """Background startup-scan progress. A separate route (not a field on
    /api/status) because the nav banner polls it every ~2s and /api/status runs a
    COUNT(*) on the photos table; this one is pure in-memory state."""
    from geotagger import scanning
    return scanning.get_scan_status()


@router.get("/api/scan/errors", response_model=ScanErrorsResponse)
async def api_scan_errors(limit: int = 500, offset: int = 0):
    """Files the scan could not index (persisted across runs, newest failure
    first) plus every warning of the most recent run (in memory only — the
    console prints just a sample). One small indexed read; not polled."""
    from geotagger import scanning, serializers
    try:
        limit = max(1, min(limit, 5000))
        offset = max(0, offset)
        rows = index.list_scan_errors(limit, offset)
        return {
            "count": index.count_scan_errors(),
            "errors": [serializers.scan_error_to_dict(r) for r in rows],
            "warnings": scanning.get_last_warnings(),
        }
    except Exception as e:
        raise HTTPException(500, str(e))


@router.delete("/api/scan/errors", response_model=ClearScanErrorsResponse)
async def api_clear_scan_errors():
    """Forget recorded failures so the next scan retries every one of them,
    including unchanged files it would otherwise skip. Refused during a scan,
    whose snapshot of the table would make the result confusing."""
    from geotagger import scanning
    try:
        if scanning.get_scan_status()["running"]:
            raise HTTPException(409, "A library scan is running; try again when it finishes")
        cleared = index.clear_all_scan_errors()
        scanning.refresh_error_count()
        return {"cleared": cleared}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/api/settings", response_model=SettingsResponse)
async def api_get_settings():
    """The safe-to-tune-live subset of config.py knobs (face matching/clustering
    thresholds, caps), with each one's current effective value and whether it's
    currently overridden from its env-resolved default."""
    try:
        overrides = index.get_all_settings()
        return {
            "settings": [
                {
                    **spec,
                    "value": getattr(config, spec["key"]),
                    "default": config.SETTINGS_DEFAULTS[spec["key"]],
                    "overridden": spec["key"] in overrides,
                }
                for spec in config.SETTINGS_SPEC
            ]
        }
    except Exception as e:
        raise HTTPException(500, str(e))


def _invalidate_for(keys) -> None:
    """Drop caches whose *contents* a changed setting invalidates (the work queue's
    batches, the face gallery/suggestion caches, ...) — a cached build made under
    the old values is wrong, not merely stale. The setting→cache map lives with
    the caches; see settings_service."""
    from geotagger.services import settings_service
    settings_service.invalidate_for(keys)


@router.patch("/api/settings", response_model=UpdateSettingsResponse)
async def api_update_settings(req: UpdateSettingsRequest):
    """Validate + persist one or more settings, applying them live (no restart)."""
    valid_keys = {spec["key"] for spec in config.SETTINGS_SPEC}
    try:
        updated = {}
        for key, raw in req.values.items():
            if key not in valid_keys:
                raise HTTPException(400, f"Unknown setting: {key}")
            value = config.apply_setting_override(key, raw)
            index.set_setting(key, str(value))
            updated[key] = value
        _invalidate_for(updated.keys())
        return {"updated": updated}
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))


@router.post("/api/settings/reset", response_model=ResetSettingsResponse)
async def api_reset_settings(req: ResetSettingsRequest):
    """Clear the DB override for one or more settings, reverting to the env default."""
    valid_keys = {spec["key"] for spec in config.SETTINGS_SPEC}
    try:
        for key in req.keys:
            if key not in valid_keys:
                raise HTTPException(400, f"Unknown setting: {key}")
            config.reset_setting(key)
            index.delete_setting(key)
        _invalidate_for(req.keys)
        return {"reset": req.keys}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/api/debug")
async def api_debug():
    try:
        db = index.get_db()
        total = db.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
        sample = db.execute("SELECT id, filename, camera FROM photos LIMIT 5").fetchall()
        return {"total": total, "sample": [dict(r) for r in sample]}
    except Exception as e:
        # A real failure, so a real status (audit A12) — not 200 + {"error"}.
        raise HTTPException(503, f"Database unavailable: {e}")
