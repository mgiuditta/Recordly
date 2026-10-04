import { describe, expect, it } from "vitest";
import { LIVE_ZOOM_HOLD_MS, LiveZoomState } from "./liveZoom";

const click = (timeMs: number, cx = 0.2, cy = 0.3) =>
	({ timeMs, cx, cy, interactionType: "click" }) as const;

describe("LiveZoomState", () => {
	it("zooms in on a click, holds, then zooms out", () => {
		const zoom = new LiveZoomState();
		zoom.onSample(click(0));
		expect(zoom.anchor).toEqual({ cx: 0.2, cy: 0.3 });

		let strength = 0;
		for (let t = 0; t <= 2000; t += 16) strength = zoom.step(t, 16);
		expect(strength).toBeGreaterThan(0.99);

		for (let t = 2016; t <= LIVE_ZOOM_HOLD_MS + 2000; t += 16) strength = zoom.step(t, 16);
		expect(strength).toBe(0);
	});

	it("keeps the first anchor while clicks keep the zoom alive", () => {
		const zoom = new LiveZoomState();
		zoom.onSample(click(0, 0.2, 0.3));
		zoom.onSample(click(1000, 0.8, 0.8));
		expect(zoom.anchor).toEqual({ cx: 0.2, cy: 0.3 });
		expect(zoom.isActive(1000 + LIVE_ZOOM_HOLD_MS - 1)).toBe(true);
	});

	it("ignores plain moves and latches on the manual toggle", () => {
		const zoom = new LiveZoomState();
		zoom.onSample({ timeMs: 0, cx: 0.5, cy: 0.5, interactionType: "move" });
		expect(zoom.isActive(1)).toBe(false);

		zoom.toggleManual({ cx: 0.6, cy: 0.4 });
		expect(zoom.isActive(60_000)).toBe(true);
		expect(zoom.anchor).toEqual({ cx: 0.6, cy: 0.4 });
		zoom.toggleManual(null);
		expect(zoom.isActive(60_000)).toBe(false);
	});
});
