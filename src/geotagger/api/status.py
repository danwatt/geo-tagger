"""Status, live-tunable settings, and debug endpoints."""

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


@router.get("/api/status")
async def api_status():
    try:
        db = index.get_db()
        total = db.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
    except Exception as e:
        total = f"error: {e}"
    return {**exiftool_status(), "db_total": total, "geocoder": geocode.status()}


@router.get("/api/scan/status")
async def api_scan_status():
    """Background startup-scan progress. A separate route (not a field on
    /api/status) because the nav banner polls it every ~2s and /api/status runs a
    COUNT(*) on the photos table; this one is pure in-memory state."""
    from geotagger import scanning
    return scanning.get_scan_status()


@router.get("/api/settings")
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
    """Drop caches whose *contents* a changed setting invalidates. The work queue's
    grouping and ranking are computed from these knobs, so a cached build made
    under the old ones is wrong, not merely stale."""
    if any(k.startswith("WORKQUEUE_") for k in keys):
        from geotagger.services import work_queue_service
        work_queue_service.invalidate()


@router.patch("/api/settings")
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


@router.post("/api/settings/reset")
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
        return {"error": str(e)}
