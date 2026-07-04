import pytest

from geotagger import osm_places


def _rect(min_lat, max_lat, min_lng, max_lng):
    """One rectangular polygon (no holes) in the stored ring format."""
    outer = [[min_lat, min_lng], [max_lat, min_lng], [max_lat, max_lng], [min_lat, max_lng]]
    return [[outer, []]]


# A city containing a nested park containing a tiny named building, plus a stadium
# elsewhere in the city, and a standalone national park in no city. Areas are set
# explicitly so "smallest containing area" is unambiguous.
CITY = dict(name="Testville", category="city", admin_level=8, area=1.0,
            polygons=_rect(40.00, 40.10, -75.10, -75.00))
PARK = dict(name="Central Park", category="park", area=0.01,
            polygons=_rect(40.04, 40.06, -75.06, -75.04))
BUILDING = dict(name="Test Hall", category="building", area=0.0001,
                polygons=_rect(40.049, 40.051, -75.051, -75.049))
STADIUM = dict(name="Test Stadium", category="venue", area=0.001,
               polygons=_rect(40.02, 40.03, -75.03, -75.02))
RESERVE = dict(name="Wildland Reserve", category="park", area=0.04,
               polygons=_rect(41.00, 41.20, -76.00, -75.80))


class TestAvailability:
    def test_unavailable_before_build(self, osm_db):
        assert osm_places.is_available() is False
        assert osm_places.lookup(40.05, -75.05) is None

    def test_status_unavailable_degrades_without_crashing(self, osm_db):
        osm_places._ensure_loaded()
        s = osm_places.status()
        assert s["available"] is False
        assert s["state"] == "unavailable"
        assert s["error"] is not None

    def test_status_ready_after_build(self, osm_db):
        osm_db([CITY, PARK])
        osm_places._ensure_loaded()
        s = osm_places.status()
        assert s == {"available": True, "state": "ready", "error": None, "places": 2}


class TestPointInMultipolygon:
    def test_inside_outer_ring(self):
        assert osm_places.point_in_multipolygon(40.05, -75.05, _rect(40.0, 40.1, -75.1, -75.0))

    def test_outside_outer_ring(self):
        assert not osm_places.point_in_multipolygon(41.0, -75.05, _rect(40.0, 40.1, -75.1, -75.0))

    def test_inside_a_hole_is_not_contained(self):
        outer = [[40.0, -75.1], [40.1, -75.1], [40.1, -75.0], [40.0, -75.0]]
        hole = [[40.04, -75.06], [40.06, -75.06], [40.06, -75.04], [40.04, -75.04]]
        polygons = [[outer, [hole]]]
        assert osm_places.point_in_multipolygon(40.0, -75.09, polygons)      # in ring, not hole
        assert not osm_places.point_in_multipolygon(40.05, -75.05, polygons)  # inside the hole


class TestLookup:
    def test_none_coordinates(self, osm_db):
        osm_db([CITY])
        assert osm_places.lookup(None, -75.0) is None
        assert osm_places.lookup(40.0, None) is None

    def test_smallest_sublocation_wins(self, osm_db):
        # Point sits inside city + park + building → building (smallest) is the sub.
        osm_db([CITY, PARK, BUILDING, STADIUM])
        assert osm_places.lookup(40.05, -75.05) == {
            "city": "Testville", "sublocation": "Test Hall",
            "category": "building", "place_id": 3,
        }

    def test_sublocation_when_not_in_the_smallest(self, osm_db):
        # Inside city + park but outside the building → park is the sub.
        osm_db([CITY, PARK, BUILDING, STADIUM])
        r = osm_places.lookup(40.05, -75.053)
        assert r["city"] == "Testville"
        assert r["sublocation"] == "Central Park"
        assert r["category"] == "park"

    def test_venue_sublocation(self, osm_db):
        osm_db([CITY, PARK, BUILDING, STADIUM])
        r = osm_places.lookup(40.025, -75.025)
        assert r["city"] == "Testville"
        assert r["sublocation"] == "Test Stadium"
        assert r["category"] == "venue"

    def test_city_only_when_no_sublocation(self, osm_db):
        osm_db([CITY, PARK, STADIUM])
        r = osm_places.lookup(40.09, -75.09)  # in the city, no smaller feature here
        assert r == {"city": "Testville", "sublocation": None,
                     "category": "city", "place_id": 1}

    def test_sublocation_with_no_city(self, osm_db):
        # A national park in no municipality → city None, the park is the place.
        osm_db([CITY, RESERVE])
        r = osm_places.lookup(41.10, -75.90)
        assert r == {"city": None, "sublocation": "Wildland Reserve",
                     "category": "park", "place_id": 2}

    def test_point_inside_nothing_returns_none(self, osm_db):
        osm_db([CITY, PARK])
        assert osm_places.lookup(39.0, -74.0) is None

    def test_innermost_of_nested_cities(self, osm_db):
        big = dict(name="Metro", category="city", admin_level=8, area=2.0,
                   polygons=_rect(40.0, 40.2, -75.2, -75.0))
        small = dict(name="Downtown", category="city", admin_level=8, area=0.2,
                     polygons=_rect(40.05, 40.10, -75.10, -75.05))
        osm_db([big, small])
        assert osm_places.lookup(40.07, -75.07)["city"] == "Downtown"


class TestPlacesInBbox:
    def test_empty_when_unavailable(self, osm_db):
        places, total = osm_places.places_in_bbox(40.0, 40.1, -75.1, -75.0)
        assert places == [] and total == 0

    def test_filters_to_bbox(self, osm_db):
        osm_db([CITY, PARK, RESERVE])
        places, total = osm_places.places_in_bbox(39.9, 40.2, -75.2, -74.9)
        assert total == 2
        assert {p["name"] for p in places} == {"Testville", "Central Park"}

    def test_caps_keeping_largest_area(self, osm_db):
        osm_db([CITY, PARK, BUILDING])
        places, total = osm_places.places_in_bbox(39.9, 40.2, -75.2, -74.9, limit=2)
        assert total == 3
        assert len(places) == 2
        assert {p["name"] for p in places} == {"Testville", "Central Park"}  # top 2 by area

    def test_place_dict_shape(self, osm_db):
        osm_db([CITY])
        places, _ = osm_places.places_in_bbox(39.9, 40.2, -75.2, -74.9)
        p = places[0]
        assert p["name"] == "Testville"
        assert p["category"] == "city"
        assert p["admin_level"] == 8
        assert isinstance(p["polygons"], list) and p["polygons"][0][0]  # has an outer ring


class TestPlaceToGeojsonFeature:
    def test_shape_and_properties(self):
        place = {"id": 1, "name": "Testville", "category": "city", "admin_level": 8,
                 "rank": 1, "area": 0.01, "polygons": _rect(40.0, 40.1, -75.1, -75.0)}
        feature = osm_places.place_to_geojson_feature(place)
        assert feature["type"] == "Feature"
        assert feature["properties"] == {
            "id": 1, "name": "Testville", "category": "city",
            "admin_level": 8, "rank": 1, "area": 0.01,
        }
        assert feature["geometry"]["type"] == "MultiPolygon"

    def test_coordinates_are_lng_lat_and_ring_closed(self):
        # Our stored ring format is [lat, lng]; GeoJSON coordinates are [lng, lat].
        # _rect()'s ring is not pre-closed (4 points), so this also covers the
        # defensive closing (GeoJSON requires first == last).
        place = {"id": 1, "name": "Testville", "category": "city", "admin_level": 8,
                 "rank": 1, "area": 0.01, "polygons": _rect(40.0, 40.1, -75.1, -75.0)}
        coords = osm_places.place_to_geojson_feature(place)["geometry"]["coordinates"]
        assert len(coords) == 1                # one polygon
        exterior = coords[0][0]                # first (and only) ring of that polygon
        assert exterior[0] == [-75.1, 40.0]    # [lng, lat], matching _rect's first corner
        assert exterior[0] == exterior[-1]     # closed ring
        assert len(exterior) == 5              # 4 corners + repeated closing point

    def test_already_closed_ring_is_not_duplicated(self):
        outer = [[40.0, -75.1], [40.1, -75.1], [40.1, -75.0], [40.0, -75.0], [40.0, -75.1]]
        place = {"id": 1, "name": "Closed", "category": "city", "admin_level": 8,
                 "rank": 1, "area": 0.01, "polygons": [[outer, []]]}
        coords = osm_places.place_to_geojson_feature(place)["geometry"]["coordinates"]
        assert len(coords[0][0]) == 5   # unchanged, not 6

    def test_holes_become_additional_rings(self):
        outer = [[40.0, -75.1], [40.1, -75.1], [40.1, -75.0], [40.0, -75.0]]
        hole = [[40.04, -75.06], [40.06, -75.06], [40.06, -75.04], [40.04, -75.04]]
        place = {"id": 1, "name": "WithHole", "category": "park", "admin_level": None,
                 "rank": 3, "area": 0.01, "polygons": [[outer, [hole]]]}
        coords = osm_places.place_to_geojson_feature(place)["geometry"]["coordinates"]
        assert len(coords[0]) == 2              # exterior ring + one hole ring
        assert coords[0][1][0] == [-75.06, 40.04]

    def test_multiple_polygons_become_multiple_multipolygon_entries(self):
        place = {"id": 1, "name": "Multi", "category": "city", "admin_level": 8,
                 "rank": 1, "area": 0.02,
                 "polygons": _rect(40.0, 40.1, -75.1, -75.0) + _rect(41.0, 41.1, -76.1, -76.0)}
        coords = osm_places.place_to_geojson_feature(place)["geometry"]["coordinates"]
        assert len(coords) == 2
