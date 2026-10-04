import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	BrowserWindow,
	desktopCapturer,
	type Display,
	globalShortcut,
	ipcMain,
	screen,
} from "electron";
import {
	setLiveInteractionListener,
	startNativeCursorMonitor,
	stopNativeCursorMonitor,
} from "./ipc/cursor/monitor";
import {
	currentCursorVisualType,
	isCursorCaptureActive,
	nativeCursorMonitorProcess,
	selectedSource,
} from "./ipc/state";
import type { CursorTelemetryPoint } from "./ipc/types";

/**
 * Live mode: the selected screen is re-rendered in real time, with Recordly's
 * auto-zoom and cursor, into an "output" window that Discord/Meet/Zoom can share.
 *
 * Single display: the output window sits behind every other window (an occluded
 * window keeps rendering and ScreenCaptureKit still captures it) and a
 * capture-protected thumbnail shows the presenter what viewers see.
 * Two displays: the output window fills the other display, no thumbnail needed.
 */

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
const RENDERER_DIST = path.join(electronDir, "..", "dist");
const CURSOR_SAMPLE_INTERVAL_MS = 1000 / 60;
const TOGGLE_ZOOM_SHORTCUT = "Alt+Z";
const MONITOR_SIZE = { width: 384, height: 216 };
const MONITOR_MARGIN = 16;

type LiveSession = {
	display: Display;
	screenSourceId: string;
	output: BrowserWindow;
	monitor: BrowserWindow | null;
	startedAt: number;
	sampleTimer: NodeJS.Timeout;
	startedCursorMonitor: boolean;
};

let session: LiveSession | null = null;

export function isLiveWebContents(webContents: Electron.WebContents | null): boolean {
	if (!session || !webContents || webContents.isDestroyed()) return false;
	return (
		session.output.webContents === webContents || session.monitor?.webContents === webContents
	);
}

function loadRenderer(win: BrowserWindow, windowType: string) {
	// Live windows are hidden or capture-protected: their console is the only window into them.
	win.webContents.on("console-message", (event) => {
		if (event.message.startsWith("[live-")) console.log(event.message);
	});
	if (VITE_DEV_SERVER_URL) {
		win.loadURL(`${VITE_DEV_SERVER_URL}?windowType=${windowType}`);
	} else {
		win.loadFile(path.join(RENDERER_DIST, "index.html"), { query: { windowType } });
	}
}

const webPreferences = (): Electron.WebPreferences => ({
	preload: path.join(electronDir, "preload.mjs"),
	nodeIntegration: false,
	contextIsolation: true,
	// An occluded output window must keep painting at full rate.
	backgroundThrottling: false,
});

function resolveCapturedDisplay(): Display {
	const displays = screen.getAllDisplays();
	const byId = displays.find((d) => String(d.id) === selectedSource?.display_id);
	// ponytail: a selected window source falls back to the display under the cursor; window-only live capture later
	return byId ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

async function resolveScreenSourceId(display: Display): Promise<string> {
	const sources = await desktopCapturer.getSources({
		types: ["screen"],
		thumbnailSize: { width: 0, height: 0 },
	});
	return sources.find((s) => s.display_id === String(display.id))?.id ?? `screen:${display.id}:0`;
}

function broadcast(channel: string, payload: unknown) {
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) win.webContents.send(channel, payload);
	}
}

function sendSample(interactionType: CursorTelemetryPoint["interactionType"] = "move") {
	if (!session || session.output.isDestroyed()) return;
	const { bounds } = session.display;
	const point = screen.getCursorScreenPoint();
	const sample: CursorTelemetryPoint = {
		timeMs: Date.now() - session.startedAt,
		cx: Math.min(1, Math.max(0, (point.x - bounds.x) / bounds.width)),
		cy: Math.min(1, Math.max(0, (point.y - bounds.y) / bounds.height)),
		interactionType,
		cursorType: currentCursorVisualType,
	};
	session.output.webContents.send("live-cursor-sample", sample);
}

function createOutputWindow(bounds: Electron.Rectangle, onOwnDisplay: boolean) {
	const win = new BrowserWindow({
		...bounds,
		title: "Recordly Live Output",
		frame: false,
		show: false,
		focusable: false,
		skipTaskbar: true,
		hasShadow: false,
		enableLargerThanScreen: true,
		backgroundColor: "#000000",
		webPreferences: webPreferences(),
	});
	win.once("ready-to-show", () => {
		win.showInactive();
		// On macOS blur() is orderBack: on a shared display the output must sit
		// behind the presenter's windows, never on top of them.
		if (!onOwnDisplay) win.blur();
		if (onOwnDisplay) win.setBounds(bounds);
	});
	loadRenderer(win, "live-output");
	return win;
}

function createMonitorWindow(display: Display) {
	const { workArea } = display;
	const win = new BrowserWindow({
		...MONITOR_SIZE,
		x: workArea.x + workArea.width - MONITOR_SIZE.width - MONITOR_MARGIN,
		y: workArea.y + workArea.height - MONITOR_SIZE.height - MONITOR_MARGIN,
		title: "Recordly Live Preview",
		frame: false,
		show: false,
		resizable: true,
		skipTaskbar: true,
		alwaysOnTop: true,
		backgroundColor: "#000000",
		webPreferences: webPreferences(),
	});
	// Hidden from every capture: our own screen grab (no mirror tunnel) and Discord.
	win.setContentProtection(true);
	win.setAlwaysOnTop(true, "floating");
	win.setAspectRatio(16 / 9);
	win.once("ready-to-show", () => win.showInactive());
	loadRenderer(win, "live-monitor");
	return win;
}

function ensureCursorMonitor(): boolean {
	if (nativeCursorMonitorProcess) return false;
	void startNativeCursorMonitor();
	return true;
}

async function startLive() {
	if (session) return;
	const display = resolveCapturedDisplay();
	const screenSourceId = await resolveScreenSourceId(display);
	const otherDisplay = screen.getAllDisplays().find((d) => d.id !== display.id);

	const output = createOutputWindow(
		otherDisplay ? otherDisplay.bounds : display.bounds,
		Boolean(otherDisplay),
	);
	const monitor = otherDisplay ? null : createMonitorWindow(display);

	session = {
		display,
		screenSourceId,
		output,
		monitor,
		startedAt: Date.now(),
		sampleTimer: setInterval(() => {
			sendSample();
			// A recording stopping kills the shared cursor monitor; bring it back for clicks.
			if (session && ensureCursorMonitor()) session.startedCursorMonitor = true;
		}, CURSOR_SAMPLE_INTERVAL_MS),
		startedCursorMonitor: ensureCursorMonitor(),
	};

	setLiveInteractionListener((event, button) => {
		if (event === "mouseup") sendSample("mouseup");
		else sendSample(button === 2 ? "right-click" : button === 3 ? "middle-click" : "click");
	});
	globalShortcut.register(TOGGLE_ZOOM_SHORTCUT, () => {
		if (session && !session.output.isDestroyed()) {
			session.output.webContents.send("live-toggle-zoom");
		}
	});

	output.on("closed", () => void stopLive());
	monitor?.on("closed", () => void stopLive());
	broadcast("live-mode-changed", { active: true });
}

export function stopLive() {
	if (!session) return;
	const ending = session;
	session = null;

	clearInterval(ending.sampleTimer);
	setLiveInteractionListener(null);
	globalShortcut.unregister(TOGGLE_ZOOM_SHORTCUT);
	if (ending.startedCursorMonitor && !isCursorCaptureActive) {
		// Only stop the helper we started; a running recording keeps its own.
		stopNativeCursorMonitor();
	}
	for (const win of [ending.output, ending.monitor]) {
		if (win && !win.isDestroyed()) win.destroy();
	}
	broadcast("live-mode-changed", { active: false });
}

export function registerLiveHandlers() {
	ipcMain.handle("toggle-live-mode", async () => {
		try {
			if (session) stopLive();
			else await startLive();
			return { success: true, active: Boolean(session) };
		} catch (error) {
			console.error("[live] toggle failed:", error);
			stopLive();
			return { success: false, active: false, error: String(error) };
		}
	});

	ipcMain.handle("get-live-mode", () => ({ success: true, active: Boolean(session) }));

	ipcMain.handle("get-live-session", () => {
		if (!session) return { success: false };
		const { display } = session;
		return {
			success: true,
			startedAt: session.startedAt,
			screenSourceId: session.screenSourceId,
			outputSourceId: session.output.getMediaSourceId(),
			captureWidth: Math.round(display.size.width * display.scaleFactor),
			captureHeight: Math.round(display.size.height * display.scaleFactor),
		};
	});
}
