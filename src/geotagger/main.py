import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from geotagger.exiftool_session import lifespan as _et_lifespan, exiftool_status
from geotagger import index, scanner, sidecar, thumbnails
from geotagger.exiftool_session import get_et

_WEB_DIR = Path(__file__).parent / "web"

@asynccontextmanager
async def lifespan(app):
    async with _et_lifespan(app):
        # Auto-reconnect to the last scanned directory so the app is usable after restart
        last_root = index.get_last_scan_root()
        if last_root:
            root = Path(last_root)
            try:
                index.init_db(root)
                thumbnails.init_thumbs(root)
                print(f"Auto-loaded index from {root}")
            except Exception as e:
                print(f"Auto-load failed: {e}")
        yield

app = FastAPI(title="Geo-Tagger", lifespan=lifespan)

# ── Models ────────────────────────────────────────────────────────────────────

class ScanRequest(BaseModel):
    directory: str

class GeotagRequest(BaseModel):
    ids: list[int]
    lat: float
    lng: float

class RemoveGeotagRequest(BaseModel):
    ids: list[int]

# ── API routes ────────────────────────────────────────────────────────────────

@app.get("/api/status")
async def api_status():
    try:
        db = index.get_db()
        total = db.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
    except Exception as e:
        total = f"error: {e}"
    return {**exiftool_status(), "db_total": total}


@app.get("/api/debug")
async def api_debug():
    try:
        db = index.get_db()
        total = db.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
        sample = db.execute("SELECT id, filename, camera FROM photos LIMIT 5").fetchall()
        return {"total": total, "sample": [dict(r) for r in sample]}
    except Exception as e:
        return {"error": str(e)}

@app.post("/api/scan")
async def api_scan(req: ScanRequest):
    root = Path(req.directory)
    if not root.is_dir():
        raise HTTPException(400, f"Not a directory: {req.directory}")

    index.init_db(root)
    thumbnails.init_thumbs(root)

    warnings = scanner.detect_sidecar_collisions(root)
    count = 0
    skipped = 0

    for p, media_type in scanner.iter_media(root):
        try:
            stat = p.stat()
            sc = sidecar.sidecar_path(p)
            sc_mtime = sc.stat().st_mtime if sc.exists() else None
            sc_path_str = str(sc) if sc.exists() else None

            if index.is_fresh(str(p), stat.st_mtime, sc_path_str, sc_mtime):
                skipped += 1
                continue

            meta = sidecar.read_metadata(p)
            index.upsert_photo(
                path=str(p), filename=p.name, dir_=str(p.parent),
                ext=p.suffix.lower(), media_type=media_type,
                mtime=stat.st_mtime, size=stat.st_size,
                lat=meta["lat"], lng=meta["lng"], geotag_source=meta["geotag_source"],
                sidecar_path=sc_path_str, sidecar_mtime=sc_mtime,
                camera=meta["camera"], photo_datetime=meta["photo_datetime"],
            )
            count += 1
        except Exception as e:
            warnings.append(f"Error indexing {p.name}: {e}")

    index.save_last_scan_root(str(root))
    return {"root": str(root), "count": count, "skipped": skipped, "warnings": warnings}


@app.get("/api/photos")
async def api_photos(
    geotagged: str = Query("all", pattern="^(all|yes|no)$"),
    bbox: str | None = Query(None),
):
    rows = index.get_photos(geotagged=geotagged, bbox=bbox)
    return [
        {
            "id": r["id"], "filename": r["filename"], "media_type": r["media_type"],
            "lat": r["lat"], "lng": r["lng"], "geotag_source": r["geotag_source"],
            "camera": r["camera"], "photo_datetime": r["photo_datetime"],
        }
        for r in rows
    ]


@app.get("/api/thumbnail/{photo_id}")
async def api_thumbnail(photo_id: int):
    row = index.get_photo(photo_id)
    if not row:
        raise HTTPException(404)
    try:
        data = thumbnails.get_thumbnail(Path(row["path"]), row["mtime"], row["size"])
        return Response(content=data, media_type="image/jpeg")
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/preview/{photo_id}")
async def api_preview(photo_id: int):
    row = index.get_photo(photo_id)
    if not row:
        raise HTTPException(404)
    try:
        data = thumbnails.get_preview(Path(row["path"]), row["mtime"], row["size"])
        return Response(content=data, media_type="image/jpeg")
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/photo/{photo_id}")
async def api_photo(photo_id: int):
    row = index.get_photo(photo_id)
    if not row:
        raise HTTPException(404)
    # Fetch extra metadata from exiftool
    try:
        et = get_et()
        meta = et.get_tags([row["path"]], tags=[
            "EXIF:Make", "EXIF:Model", "EXIF:DateTimeOriginal",
            "EXIF:ImageWidth", "EXIF:ImageHeight",
            "Composite:ImageSize",
        ])
        extra = meta[0] if meta else {}
    except Exception:
        extra = {}

    return {
        "id": row["id"],
        "path": row["path"],
        "filename": row["filename"],
        "media_type": row["media_type"],
        "ext": row["ext"],
        "lat": row["lat"],
        "lng": row["lng"],
        "geotag_source": row["geotag_source"],
        "sidecar_path": row["sidecar_path"],
        "camera": f"{extra.get('EXIF:Make', '')} {extra.get('EXIF:Model', '')}".strip() or None,
        "datetime": extra.get("EXIF:DateTimeOriginal"),
        "dimensions": extra.get("Composite:ImageSize"),
    }


@app.post("/api/geotag")
async def api_geotag(req: GeotagRequest):
    results = []
    for photo_id in req.ids:
        row = index.get_photo(photo_id)
        if not row:
            continue
        p = Path(row["path"])
        sc = sidecar.write_gps(p, req.lat, req.lng)
        sc_mtime = sc.stat().st_mtime if sc.exists() else None
        index.update_geotag(photo_id, req.lat, req.lng, "sidecar", str(sc), sc_mtime)
        results.append({
            "id": photo_id, "lat": req.lat, "lng": req.lng,
            "geotag_source": "sidecar", "sidecar_path": str(sc),
        })
    return results


@app.post("/api/geotag/remove")
async def api_geotag_remove(req: RemoveGeotagRequest):
    results = []
    for photo_id in req.ids:
        row = index.get_photo(photo_id)
        if not row:
            continue
        p = Path(row["path"])
        sc = sidecar.remove_gps(p)
        sc_mtime = sc.stat().st_mtime if sc.exists() else None
        index.update_geotag(photo_id, None, None, "none", str(sc), sc_mtime)
        results.append({"id": photo_id, "geotag_source": "none"})
    return results


# ── Static files (must be last) ───────────────────────────────────────────────
app.mount("/", StaticFiles(directory=str(_WEB_DIR), html=True), name="web")
