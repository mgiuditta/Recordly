import { CLICK_CLUSTER_MERGE_GAP_MS } from "../video-editor/timeline/zoomSuggestionUtils";
import {
	type CursorTelemetryPoint,
	DEFAULT_AUTO_ZOOM_DEPTH,
	DEFAULT_ZOOM_IN_DURATION_MS,
	DEFAULT_ZOOM_OUT_DURATION_MS,
	ZOOM_DEPTH_SCALES,
	type ZoomFocus,
} from "../video-editor/types";
import { easeOutZoom } from "../video-editor/videoPlayback/mathUtils";

export const LIVE_ZOOM_SCALE = ZOOM_DEPTH_SCALES[DEFAULT_AUTO_ZOOM_DEPTH];
/** Same window the editor uses to merge clicks into one zoom: each click extends the hold. */
export const LIVE_ZOOM_HOLD_MS = CLICK_CLUSTER_MERGE_GAP_MS;

const CLICK_TYPES = new Set<CursorTelemetryPoint["interactionType"]>([
	"click",
	"double-click",
	"right-click",
	"middle-click",
]);

/**
 * Real-time version of the editor's click zoom. The editor sees the whole
 * recording and starts zooming before a click; live mode only learns about a
 * click when it happens, so it zooms in on the click, holds while clicks keep
 * coming, and zooms out after a quiet stretch. Alt+Z latches the zoom on.
 */
export class LiveZoomState {
	private ramp = 0;
	private holdUntilMs = 0;
	private manual = false;
	anchor: ZoomFocus = { cx: 0.5, cy: 0.5 };

	onSample(sample: CursorTelemetryPoint) {
		if (!CLICK_TYPES.has(sample.interactionType)) return;
		if (!this.isActive(sample.timeMs)) this.anchor = { cx: sample.cx, cy: sample.cy };
		this.holdUntilMs = sample.timeMs + LIVE_ZOOM_HOLD_MS;
	}

	toggleManual(cursor: ZoomFocus | null) {
		this.manual = !this.manual;
		if (this.manual && this.ramp === 0 && cursor) this.anchor = cursor;
		if (!this.manual) this.holdUntilMs = 0;
	}

	isActive(nowMs: number) {
		return this.manual || nowMs < this.holdUntilMs;
	}

	/** Advances the zoom ramp and returns its eased strength in [0, 1]. */
	step(nowMs: number, deltaMs: number): number {
		const active = this.isActive(nowMs);
		const duration = active ? DEFAULT_ZOOM_IN_DURATION_MS : DEFAULT_ZOOM_OUT_DURATION_MS;
		const direction = active ? 1 : -1;
		this.ramp = Math.min(1, Math.max(0, this.ramp + (direction * deltaMs) / duration));
		// Zoom-out mirrors the ease so both ends decelerate into rest.
		return active ? easeOutZoom(this.ramp) : 1 - easeOutZoom(1 - this.ramp);
	}
}
