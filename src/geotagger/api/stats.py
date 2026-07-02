"""Library statistics endpoints (monthly/daily counts, summary snapshot, bounds)."""

from fastapi import APIRouter, HTTPException, Query

from geotagger import index, geocode

router = APIRouter()


@router.get("/api/stats/months")
async def api_stats_months():
    """Get photo counts grouped by year/month with geotagged breakdown."""
    try:
        db = index.get_db()
        # Get monthly counts with geotagged breakdown
        rows = db.execute("""
            SELECT
                strftime('%Y', photo_datetime, 'unixepoch') as year,
                strftime('%m', photo_datetime, 'unixepoch') as month,
                COUNT(*) as total,
                SUM(CASE WHEN lat IS NOT NULL OR geocode_ignored = 1 THEN 1 ELSE 0 END) as geotagged,
                SUM(CASE WHEN lat IS NULL AND geocode_ignored = 0 THEN 1 ELSE 0 END) as not_geotagged
            FROM photos
            WHERE photo_datetime IS NOT NULL AND photo_datetime > 0
            GROUP BY year, month
            ORDER BY year DESC, month DESC
        """).fetchall()

        return {
            "months": [
                {
                    "year": int(r["year"]),
                    "month": int(r["month"]),
                    "total": r["total"],
                    "geotagged": r["geotagged"],
                    "not_geotagged": r["not_geotagged"]
                }
                for r in rows
            ]
        }
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/api/stats/summary")
async def api_stats_summary():
    """One-shot health snapshot for the home dashboard: library size, geotagging /
    reverse-geocoding / face-labeling progress, and people/context counts."""
    try:
        import bisect

        db = index.get_db()

        row = db.execute("""
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN media_type = 'image' THEN 1 ELSE 0 END) as images,
                SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END) as videos,
                SUM(CASE WHEN lat IS NOT NULL THEN 1 ELSE 0 END) as tagged,
                SUM(CASE WHEN lat IS NULL AND geocode_ignored = 1 THEN 1 ELSE 0 END) as ignored,
                SUM(CASE WHEN lat IS NULL AND geocode_ignored = 0 THEN 1 ELSE 0 END) as untagged
            FROM photos
        """).fetchone()

        # Untagged photos with a geotagged photo within window_sec are "guessable"
        # via time-neighbors. Two sorted-timestamp lists + bisect keeps this to a
        # couple of indexed queries and an O(n log m) sweep instead of a per-row EXISTS.
        window_sec = 900
        tagged_times = [r[0] for r in db.execute(
            "SELECT photo_datetime FROM photos "
            "WHERE lat IS NOT NULL AND photo_datetime IS NOT NULL AND photo_datetime > 0 "
            "ORDER BY photo_datetime"
        ).fetchall()]
        untagged_times = [r[0] for r in db.execute(
            "SELECT photo_datetime FROM photos "
            "WHERE lat IS NULL AND geocode_ignored = 0 "
            "AND photo_datetime IS NOT NULL AND photo_datetime > 0 "
            "ORDER BY photo_datetime"
        ).fetchall()]
        guessable_count = 0
        for t in untagged_times:
            idx = bisect.bisect_left(tagged_times, t)
            near = ((idx < len(tagged_times) and tagged_times[idx] - t <= window_sec) or
                    (idx > 0 and t - tagged_times[idx - 1] <= window_sec))
            if near:
                guessable_count += 1

        return {
            "photos": {"total": row["total"], "images": row["images"], "videos": row["videos"]},
            "geotag": {"tagged": row["tagged"], "ignored": row["ignored"], "untagged": row["untagged"]},
            "guessable": {"count": guessable_count, "window_sec": window_sec},
            "geocode": {
                **geocode.status(),
                "geocoded": index.count_geocoded_photos(),
                "pending": index.count_photos_needing_geocode(),
            },
            "faces": {
                "unscanned_photos": len(index.get_unscanned_photo_ids()),
                "total": index.count_faces("all"),
                "labeled": index.count_faces("recent"),
                "unlabeled": index.count_faces("unlabeled"),
                "ignored": index.count_faces("ignored"),
            },
            "people": {
                "persons": db.execute("SELECT COUNT(*) FROM persons").fetchone()[0],
                "families": db.execute("SELECT COUNT(*) FROM families").fetchone()[0],
            },
            "contexts": {"count": db.execute("SELECT COUNT(*) FROM contexts").fetchone()[0]},
        }
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/api/stats/bounds")
async def api_stats_bounds():
    """Get the bounding box of all geotagged photos."""
    try:
        db = index.get_db()
        row = db.execute("""
            SELECT MIN(lat) as min_lat, MAX(lat) as max_lat,
                   MIN(lng) as min_lng, MAX(lng) as max_lng
            FROM photos WHERE lat IS NOT NULL
        """).fetchone()
        if not row or row["min_lat"] is None:
            return {"has_data": False}
        return {
            "has_data": True,
            "min_lat": row["min_lat"],
            "max_lat": row["max_lat"],
            "min_lng": row["min_lng"],
            "max_lng": row["max_lng"],
        }
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/api/stats/dates")
async def api_stats_dates(year: int | None = Query(None), month: int | None = Query(None)):
    """Get photo counts grouped by date, optionally filtered by year/month."""
    try:
        db = index.get_db()

        # Build query based on filters
        where_clause = "WHERE photo_datetime IS NOT NULL AND photo_datetime > 0"
        params = []

        if year is not None and month is not None:
            # Filter to specific month
            where_clause += " AND strftime('%Y', photo_datetime, 'unixepoch') = ? AND strftime('%m', photo_datetime, 'unixepoch') = ?"
            params = [str(year), f"{month:02d}"]

        # Get daily counts
        rows = db.execute(f"""
            SELECT
                DATE(photo_datetime, 'unixepoch') as date,
                COUNT(*) as count
            FROM photos
            {where_clause}
            GROUP BY date
            ORDER BY date
        """, params).fetchall()

        return {
            "dates": [
                {"date": r["date"], "count": r["count"]}
                for r in rows
            ]
        }
    except Exception as e:
        raise HTTPException(500, str(e))
