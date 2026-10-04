// Spike: can Discord share a hidden full-res "output" window while the user
// watches a capture-protected thumbnail? MODE=offscreen|behind (default offscreen).
const { app, BrowserWindow, screen, session, desktopCapturer, globalShortcut, ipcMain } = require("electron");
const path = require("node:path");

app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

const MODE = process.env.MODE ?? "offscreen";
let output;
let monitor;

app.whenReady().then(async () => {
	const display = screen.getPrimaryDisplay();
	const { width, height } = display.size;
	const prefs = { preload: path.join(__dirname, "preload.cjs"), backgroundThrottling: false };

	output = new BrowserWindow({
		width, height, frame: false, show: false, enableLargerThanScreen: true,
		title: "Recordly Output", webPreferences: prefs,
	});
	output.loadFile("output.html");
	output.once("ready-to-show", () => {
		if (MODE === "offscreen") output.setBounds({ x: width + 200, y: 0, width, height });
		output.showInactive();
		if (MODE === "behind") output.blur();
		console.log("[spike] mode", MODE, "output bounds", output.getBounds(), "source", output.getMediaSourceId());
	});

	monitor = new BrowserWindow({
		width: 384, height: 216, x: width - 400, y: height - 260, frame: false,
		alwaysOnTop: true, resizable: true, webPreferences: prefs,
	});
	monitor.setContentProtection(true); // ponytail: hidden from every capture, Discord included — fine, it's only for you
	monitor.loadFile("monitor.html");

	session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
		const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
		const isMonitor = request.frame?.url?.endsWith("monitor.html");
		const wanted = isMonitor ? output.getMediaSourceId() : `screen:${display.id}:0`;
		const source = sources.find((s) => s.id === wanted) ?? sources.find((s) => s.id.startsWith("screen:"));
		console.log("[spike]", isMonitor ? "monitor" : "output", "→", source?.id, source?.name);
		callback({ video: source });
	});

	setInterval(() => {
		const p = screen.getCursorScreenPoint();
		output?.webContents.send("cursor", { x: (p.x - display.bounds.x) / width, y: (p.y - display.bounds.y) / height });
	}, 1000 / 120);

	globalShortcut.register("Alt+Z", () => output?.webContents.send("toggle-zoom"));
	ipcMain.on("log", (_e, msg) => console.log("[renderer]", msg));
});

app.on("will-quit", () => globalShortcut.unregisterAll());
