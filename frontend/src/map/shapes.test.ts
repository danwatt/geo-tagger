import { describe, expect, it } from "vitest";
import {
  MIN_RECT_DEG, circleRadius, distanceMeters, edgeLatLng, formatRadius, insideShape, isTooSmall, parseShape,
  rectCorner, resizeRect, serializeShape, shapeBbox, translateRect,
} from "./shapes";

describe("parseShape / serializeShape", () => {
  it("round-trips a rectangle in the stored key order", () => {
    const json = '{"north":3,"south":1,"east":4,"west":2}';
    const shape = parseShape("rectangle", json);
    expect(shape).toEqual({ type: "rectangle", bounds: { north: 3, south: 1, east: 4, west: 2 } });
    expect(serializeShape(shape!)).toBe(json);
    // Key order of the input doesn't matter; the output's is fixed.
    expect(serializeShape(parseShape("rectangle", '{"south":1,"west":2,"north":3,"east":4}')!)).toBe(json);
  });

  it("round-trips a circle", () => {
    const json = '{"lat":1.5,"lng":-2.25,"radius":50}';
    const shape = parseShape("circle", json);
    expect(shape).toEqual({ type: "circle", bounds: { lat: 1.5, lng: -2.25, radius: 50 } });
    expect(serializeShape(shape!)).toBe(json);
    expect(circleRadius(json)).toBe(50);
  });

  it("rejects unreadable bounds instead of throwing", () => {
    expect(parseShape("circle", "not json")).toBeNull();
    expect(parseShape("circle", '{"lat":1,"lng":2}')).toBeNull();
    expect(parseShape("rectangle", '{"north":"3","south":1,"east":4,"west":2}')).toBeNull();
    expect(parseShape("polygon", '{"lat":1,"lng":2,"radius":3}')).toBeNull();
    expect(parseShape("circle", "null")).toBeNull();
    expect(circleRadius("garbage")).toBe(0);
  });
});

describe("size floors", () => {
  it("flags shapes below the draw tool's minimum", () => {
    expect(isTooSmall({ type: "circle", bounds: { lat: 0, lng: 0, radius: 1.9 } })).toBe(true);
    expect(isTooSmall({ type: "circle", bounds: { lat: 0, lng: 0, radius: 2 } })).toBe(false);
    expect(isTooSmall({ type: "rectangle", bounds: { north: 1, south: 0, east: 0.00001, west: 0 } })).toBe(true);
    expect(isTooSmall({ type: "rectangle", bounds: { north: 1, south: 0, east: 1, west: 0 } })).toBe(false);
  });

  it("resizes around the fixed corner and never collapses to a line", () => {
    expect(resizeRect({ lat: 0, lng: 0 }, { lat: 2, lng: -3 })).toEqual({ north: 2, south: 0, east: 0, west: -3 });
    const thin = resizeRect({ lat: 10, lng: 10 }, { lat: 10, lng: 12 });
    expect(thin.north - thin.south).toBeCloseTo(MIN_RECT_DEG);
    expect(thin.north).toBeCloseTo(10 + MIN_RECT_DEG);
  });

  it("translates a rectangle by degrees, clamped at the poles", () => {
    const b = { north: 80, south: 70, east: 10, west: 0 };
    expect(translateRect(b, 5, 3)).toEqual({ north: 85, south: 75, east: 13, west: 3 });
    expect(translateRect(b, 50, 0)).toEqual({ north: 90, south: 80, east: 10, west: 0 });
    expect(rectCorner(b, "nw")).toEqual({ lat: 80, lng: 0 });
    expect(rectCorner(b, "se")).toEqual({ lat: 70, lng: 10 });
  });
});

describe("circle geometry", () => {
  it("bounds a circle with its box and filters to the ring", () => {
    const circle = { type: "circle" as const, bounds: { lat: 0, lng: 0, radius: 1000 } };
    const box = shapeBbox(circle);
    expect(box.max_lat).toBeCloseTo(1000 / 111320);
    expect(box.min_lng).toBeCloseTo(-1000 / 111320);
    // The box's corner is outside the ring; a point near the centre is inside.
    expect(insideShape(circle, { lat: box.max_lat, lng: box.max_lng })).toBe(false);
    expect(insideShape(circle, { lat: 0.001, lng: 0.001 })).toBe(true);
  });

  it("puts the radius handle due east, matching the distance", () => {
    const c = { lat: 45, lng: 10 };
    const edge = edgeLatLng(c, 500);
    expect(edge.lat).toBe(45);
    expect(distanceMeters(c, edge)).toBeCloseTo(500, -1);
  });

  it("formats radii in metres and kilometres", () => {
    expect(formatRadius(249.6)).toBe("250 m");
    expect(formatRadius(1500)).toBe("1.50 km");
    expect(formatRadius(12000)).toBe("12 km");
  });

  it("rectangles take the whole box", () => {
    const rect = { type: "rectangle" as const, bounds: { north: 1, south: 0, east: 1, west: 0 } };
    expect(shapeBbox(rect)).toEqual({ min_lat: 0, max_lat: 1, min_lng: 0, max_lng: 1 });
    expect(insideShape(rect, { lat: 0.99, lng: 0.99 })).toBe(true);
  });
});
