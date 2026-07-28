"""Unit test for the detection coordinate handling in faces.detect_faces.

Detection runs on the UPRIGHT image (SCRFD/ArcFace expect upright faces), and the
resulting boxes must be mapped back to sensor space for storage. This verifies that
mapping without needing the real model or a real RAW — the detection preview and the
face model are both mocked.
"""
import io
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from geotagger import faces, thumbnails


def _fake_preview(monkeypatch, w=100, h=200):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (30, 30, 30)).save(buf, "JPEG")
    monkeypatch.setattr(thumbnails, "get_detection_preview",
                        lambda *a, **k: (buf.getvalue(), False))


class _FakeFace:
    def __init__(self, bbox, det_score=0.9, seed=1.0):
        self.bbox = np.array(bbox, dtype=np.float32)
        self.det_score = det_score
        self.normed_embedding = np.full(512, seed, dtype=np.float32)


class TestEmbedBbox:
    """faces.embed_bbox — the recognition half of a hand-drawn face box."""

    def test_reuses_overlapping_detection(self, monkeypatch):
        _fake_preview(monkeypatch)
        # Model box at 10..40 x, 20..80 y on a 100×200 image → 0.1,0.1,0.4,0.4.
        monkeypatch.setattr(faces, "_get_app", lambda: type("A", (), {
            "get": lambda self, arr: [_FakeFace([10, 20, 40, 80], 0.77, seed=0.5)]})())

        # A generously drawn box over the same face: overlapping enough to match.
        emb, score = faces.embed_bbox(Path("x.jpg"), 1.0, 1, [0.08, 0.08, 0.45, 0.45])
        assert score == pytest.approx(0.77)
        assert faces.decode_embedding(emb)[0] == pytest.approx(0.5)

    def test_falls_back_to_detecting_inside_the_crop(self, monkeypatch):
        """No overlap on the full image → re-detect in the (upscaled) crop."""
        _fake_preview(monkeypatch)
        calls = []

        class FakeApp:
            def get(self, arr):
                calls.append(arr.shape)
                # First pass (full image): a face nowhere near the drawn box.
                if len(calls) == 1:
                    return [_FakeFace([90, 180, 99, 199], 0.9, seed=0.1)]
                return [_FakeFace([1, 1, 20, 20], 0.42, seed=0.9)]

        monkeypatch.setattr(faces, "_get_app", lambda: FakeApp())
        emb, score = faces.embed_bbox(Path("x.jpg"), 1.0, 1, [0.1, 0.1, 0.3, 0.3])
        assert len(calls) == 2                       # full image, then the crop
        assert score == pytest.approx(0.42)
        assert faces.decode_embedding(emb)[0] == pytest.approx(0.9)

    def test_returns_none_when_nothing_found(self, monkeypatch):
        _fake_preview(monkeypatch)
        monkeypatch.setattr(faces, "_get_app",
                            lambda: type("A", (), {"get": lambda self, arr: []})())
        assert faces.embed_bbox(Path("x.jpg"), 1.0, 1, [0.1, 0.1, 0.3, 0.3]) == (None, None)


def test_detect_faces_maps_upright_boxes_back_to_sensor_space(monkeypatch):
    # A synthetic upright detection image: portrait 100×200.
    buf = io.BytesIO()
    Image.new("RGB", (100, 200), (30, 30, 30)).save(buf, "JPEG")
    monkeypatch.setattr(thumbnails, "get_detection_preview",
                        lambda *a, **k: (buf.getvalue(), False))

    class FakeFace:
        bbox = np.array([10.0, 20.0, 40.0, 80.0])   # pixels on the 100×200 upright image
        det_score = 0.9
        normed_embedding = np.zeros(512, dtype=np.float32)

    class FakeApp:
        def get(self, arr):
            return [FakeFace()]

    monkeypatch.setattr(faces, "_get_app", lambda: FakeApp())

    results, dim = faces.detect_faces(Path("x.nef"), 1.0, 1, orientation=6)

    assert dim is None                         # is_full False → not recorded
    assert len(results) == 1
    # Detected box normalized on the upright image, then mapped back to sensor space.
    disp = [0.1, 0.1, 0.4, 0.4]                 # 10/100, 20/200, 40/100, 80/200
    expected = thumbnails.unorient_bbox(disp, 6)
    got = [float(v) for v in results[0]["bbox"].split(",")]
    assert got == pytest.approx(expected, abs=1e-4)
    # And it round-trips: orienting the stored box for display recovers the detection.
    assert thumbnails.orient_bbox(got, 6) == pytest.approx(disp, abs=1e-4)
