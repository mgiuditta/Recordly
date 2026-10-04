import { useEffect, useRef, useState } from "react";

/**
 * The presenter's thumbnail: a capture of the output window itself, so it shows
 * exactly the pixels Discord sends. The window is capture-protected in main.
 */
export function LiveMonitorWindow() {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let stream: MediaStream | null = null;
		let disposed = false;

		const run = async () => {
			const session = await window.electronAPI.getLiveSession();
			if (!session.success) throw new Error("Live session not running");
			stream = await navigator.mediaDevices.getUserMedia({
				audio: false,
				video: {
					mandatory: {
						chromeMediaSource: "desktop",
						chromeMediaSourceId: session.outputSourceId,
						maxFrameRate: 30,
					},
				},
			} as unknown as MediaStreamConstraints);
			if (disposed) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			if (videoRef.current) videoRef.current.srcObject = stream;
			console.info("[live-monitor] showing output window", session.outputSourceId);
		};

		run().catch((err: unknown) => {
			console.error("[live-monitor]", err);
			if (!disposed) setError(String(err));
		});

		return () => {
			disposed = true;
			for (const track of stream?.getTracks() ?? []) track.stop();
		};
	}, []);

	return (
		<div
			style={
				{
					position: "fixed",
					inset: 0,
					background: "#000",
					borderRadius: 10,
					overflow: "hidden",
					WebkitAppRegion: "drag",
				} as React.CSSProperties
			}
		>
			<video
				ref={videoRef}
				autoPlay
				muted
				playsInline
				style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
			/>
			{error && (
				<p
					style={{
						position: "absolute",
						top: 8,
						left: 8,
						color: "#f87171",
						font: "11px system-ui",
					}}
				>
					{error}
				</p>
			)}
		</div>
	);
}
