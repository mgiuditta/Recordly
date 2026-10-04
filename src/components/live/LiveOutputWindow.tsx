import { Application, Container, Sprite, Texture, VideoSource } from "pixi.js";
import { MotionBlurFilter } from "pixi-filters/motion-blur";
import { ZoomBlurFilter } from "pixi-filters/zoom-blur";
import { useEffect, useRef, useState } from "react";
import { destroyPixiApplication, initializePixiApplication } from "@/lib/pixiApplicationLifecycle";
import {
	type CursorTelemetryPoint,
	DEFAULT_CURSOR_SIZE,
	DEFAULT_CURSOR_SMOOTHING,
	DEFAULT_ZOOM_MOTION_BLUR,
	DEFAULT_ZOOM_MOTION_BLUR_TUNING,
	DEFAULT_ZOOM_SMOOTHNESS,
} from "../video-editor/types";
import {
	computeCursorFollowFocus,
	createCursorFollowCameraState,
} from "../video-editor/videoPlayback/cursorFollowCamera";
import {
	DEFAULT_CURSOR_CONFIG,
	PixiCursorOverlay,
	preloadCursorAssets,
} from "../video-editor/videoPlayback/cursorRenderer";
import {
	createSpringState,
	getZoomSpringConfig,
	stepSpringValue,
} from "../video-editor/videoPlayback/motionSmoothing";
import {
	applyZoomTransform,
	computeZoomTransform,
	createMotionBlurState,
} from "../video-editor/videoPlayback/zoomTransform";
import { LIVE_ZOOM_SCALE, LiveZoomState } from "./liveZoom";

/** Cursor interpolation only looks a few frames back; keep a short tail. */
const SAMPLE_WINDOW_MS = 3000;

async function openScreenStream(sourceId: string, width: number, height: number) {
	// Same desktop-capture path as the recorder, with the OS cursor left out so
	// Recordly's own cursor is the only one viewers see.
	const constraints = {
		audio: false,
		video: {
			mandatory: {
				chromeMediaSource: "desktop",
				chromeMediaSourceId: sourceId,
				maxWidth: width,
				maxHeight: height,
				maxFrameRate: 60,
				minFrameRate: 30,
				googCaptureCursor: false,
			},
			cursor: "never",
		},
	} as unknown as MediaStreamConstraints;
	return navigator.mediaDevices.getUserMedia(constraints);
}

function fitContain(
	stage: { width: number; height: number },
	video: { width: number; height: number },
) {
	const scale = Math.min(stage.width / video.width, stage.height / video.height);
	const width = video.width * scale;
	const height = video.height * scale;
	return { x: (stage.width - width) / 2, y: (stage.height - height) / 2, width, height };
}

export function LiveOutputWindow() {
	const hostRef = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;

		let disposed = false;
		let stream: MediaStream | null = null;
		const app = new Application();
		const unsubscribers: Array<() => void> = [];

		const run = async () => {
			const session = await window.electronAPI.getLiveSession();
			if (!session.success) throw new Error("Live session not running");

			stream = await openScreenStream(
				session.screenSourceId,
				session.captureWidth,
				session.captureHeight,
			);
			if (disposed) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			const video = document.createElement("video");
			video.muted = true;
			video.playsInline = true;
			video.srcObject = stream;
			await video.play();
			console.info(
				"[live-output] capturing",
				session.screenSourceId,
				video.videoWidth,
				video.videoHeight,
			);

			await preloadCursorAssets();
			await initializePixiApplication(app, {
				resizeTo: host,
				background: "#000000",
				antialias: true,
				resolution: window.devicePixelRatio || 1,
				autoDensity: true,
				preference: "webgl",
				autoStart: true,
				sharedTicker: false,
			});
			if (disposed) return;
			host.appendChild(app.canvas);
			app.ticker.maxFPS = 60;

			// Same scene graph as the editor preview: blur only touches the video,
			// the cursor rides the camera on top.
			const camera = new Container();
			const videoEffects = new Container();
			const motionBlurFilter = new MotionBlurFilter([0, 0], 5, 0);
			const zoomBlurFilter = new ZoomBlurFilter({ strength: 0, maxKernelSize: 13 });
			videoEffects.filters = [motionBlurFilter, zoomBlurFilter];
			const videoSource = new VideoSource({ resource: video, autoPlay: true });
			videoSource.autoUpdate = true;
			const sprite = new Sprite(Texture.from(videoSource));
			const cursorLayer = new Container();
			const cursor = new PixiCursorOverlay({
				dotRadius: DEFAULT_CURSOR_CONFIG.dotRadius * DEFAULT_CURSOR_SIZE,
				minViewportScale: 0,
				smoothingFactor: DEFAULT_CURSOR_SMOOTHING,
			});
			cursor.setFilterResolution(app.renderer.resolution);
			videoEffects.addChild(sprite);
			cursorLayer.addChild(cursor.container);
			camera.addChild(videoEffects, cursorLayer);
			app.stage.addChild(camera);

			const samples: CursorTelemetryPoint[] = [];
			const zoom = new LiveZoomState();
			const follow = createCursorFollowCameraState();
			const springs = {
				scale: createSpringState(1),
				x: createSpringState(0),
				y: createSpringState(0),
			};
			const springConfig = getZoomSpringConfig(DEFAULT_ZOOM_SMOOTHNESS);
			const motionBlurState = createMotionBlurState();

			unsubscribers.push(
				window.electronAPI.onLiveCursorSample((sample) => {
					samples.push(sample);
					zoom.onSample(sample);
					const cutoff = sample.timeMs - SAMPLE_WINDOW_MS;
					while (samples.length > 2 && samples[0].timeMs < cutoff) samples.shift();
				}),
				window.electronAPI.onLiveToggleZoom(() => {
					const last = samples[samples.length - 1];
					zoom.toggleManual(last ? { cx: last.cx, cy: last.cy } : null);
				}),
			);

			app.ticker.add((ticker) => {
				const stageSize = { width: app.screen.width, height: app.screen.height };
				const videoSize = {
					width: video.videoWidth || stageSize.width,
					height: video.videoHeight || stageSize.height,
				};
				const baseMask = fitContain(stageSize, videoSize);
				sprite.position.set(baseMask.x, baseMask.y);
				sprite.setSize(baseMask.width, baseMask.height);

				const nowMs = Date.now() - session.startedAt;
				const strength = zoom.step(nowMs, ticker.deltaMS);
				const focus = computeCursorFollowFocus(
					follow,
					samples,
					nowMs,
					LIVE_ZOOM_SCALE,
					strength,
					zoom.anchor,
				);
				const projected = computeZoomTransform({
					stageSize,
					baseMask,
					zoomScale: LIVE_ZOOM_SCALE,
					zoomProgress: strength,
					focusX: focus.cx,
					focusY: focus.cy,
				});
				applyZoomTransform({
					cameraContainer: camera,
					motionBlurFilter,
					zoomBlurFilter,
					stageSize,
					baseMask,
					zoomScale: LIVE_ZOOM_SCALE,
					zoomProgress: strength,
					focusX: focus.cx,
					focusY: focus.cy,
					isPlaying: true,
					motionBlurAmount: DEFAULT_ZOOM_MOTION_BLUR,
					motionBlurTuning: DEFAULT_ZOOM_MOTION_BLUR_TUNING,
					motionBlurState,
					transformOverride: {
						scale: stepSpringValue(
							springs.scale,
							projected.scale,
							ticker.deltaMS,
							springConfig,
						),
						x: stepSpringValue(springs.x, projected.x, ticker.deltaMS, springConfig),
						y: stepSpringValue(springs.y, projected.y, ticker.deltaMS, springConfig),
					},
				});
				cursor.update(samples, nowMs, baseMask, samples.length > 0);
			});
		};

		run().catch((err: unknown) => {
			if (disposed) return;
			console.error("[live-output]", err);
			setError(String(err));
		});

		return () => {
			disposed = true;
			for (const unsubscribe of unsubscribers) unsubscribe();
			for (const track of stream?.getTracks() ?? []) track.stop();
			destroyPixiApplication(app, "live-output");
		};
	}, []);

	return (
		<div ref={hostRef} style={{ position: "fixed", inset: 0, background: "#000" }}>
			{error && (
				<p style={{ color: "#f87171", font: "14px system-ui", padding: 24 }}>{error}</p>
			)}
		</div>
	);
}
