/**
 * 桌面壳应用内更新桥（issue #180）。
 *
 * 打包后的桌面应用服务来自包内 `dist/server`，`npm i -g pi-web-ui@latest`
 * 换不掉它 —— 更新面板在桌面壳里必须走 electron-updater（主进程直连
 * GitHub releases 的 latest*.yml），而不是 npm 那套终端命令。
 *
 * 主进程（desktop/main.ts）↔ preload（desktop/preload.ts）↔ 这里：
 * invoke（check/download/quit-install/set-auto/status）+ event 订阅。
 * 纯函数（reduceUpdaterEvent / desktopReleasesUrl / getDesktopUpdaterBridge）可单测。
 *
 * 状态存在**模块级单例**（同 web/src/app-globals.ts 的做法），不是组件内 state：
 * 更新界面住在设置面板里，而设置面板开关即卸载 —— 组件内 state 会在重开时退回
 * idle（用户下载到一半关掉设置，回来就看不到进度了）。单例 + 常驻订阅还顺带解决
 * 「启动检查的事件早于任何监听者」：第一次订阅时用 status() 补齐主进程留的那条。
 */
import { useEffect, useState } from "react";
import { isDesktopShell, type DesktopShellWindow } from "./desktop.js";

export const DESKTOP_REPO = "xing-shuyin/pi-web-ui";

/** 与 desktop/preload.ts 的 DesktopUpdaterEvent 同构。 */
export interface DesktopUpdaterEvent {
	state: "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error";
	version?: string | null;
	percent?: number;
	message?: string;
}

export interface DesktopUpdaterBridge {
	check: () => Promise<unknown>;
	download: () => Promise<unknown>;
	quitAndInstall: () => Promise<unknown>;
	onEvent: (cb: (msg: DesktopUpdaterEvent) => void) => () => void;
	/** 通知主进程自动更新开关（旧桌面壳没有这个通道，调用前用 typeof 判一下）。 */
	setAuto?: (enabled: boolean) => Promise<unknown>;
	/** 取主进程留存的最近一条事件（旧桌面壳没有 → 不补历史）。 */
	status?: () => Promise<unknown>;
}

export type DesktopUpdaterState =
	"idle" | "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error";

export interface DesktopUpdaterStatus {
	state: DesktopUpdaterState;
	/** electron-updater 报的远端版本（null = 还没结论）。 */
	version: string | null;
	/** downloading 时的 0-100。 */
	percent: number;
	/** error 时的原始信息。 */
	message: string | null;
}

export const INITIAL_DESKTOP_UPDATER_STATUS: DesktopUpdaterStatus = {
	state: "idle",
	version: null,
	percent: 0,
	message: null,
};

function clampPercent(n: unknown): number {
	return typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

/** 主进程事件 → 面板状态（纯函数，单测覆盖）。 */
export function reduceUpdaterEvent(prev: DesktopUpdaterStatus, event: DesktopUpdaterEvent): DesktopUpdaterStatus {
	switch (event.state) {
		case "checking":
			return { ...prev, state: "checking", message: null };
		case "available":
			return { ...prev, state: "available", version: event.version ?? prev.version, message: null };
		case "up-to-date":
			return { ...prev, state: "up-to-date", version: event.version ?? prev.version, message: null };
		case "downloading":
			return { ...prev, state: "downloading", percent: clampPercent(event.percent), message: null };
		case "downloaded":
			return {
				...prev,
				state: "downloaded",
				version: event.version ?? prev.version,
				percent: 100,
				message: null,
			};
		case "error":
			return { ...prev, state: "error", message: event.message ?? "unknown error" };
		default:
			return prev;
	}
}

/**
 * preload 桥是否可用：桌面壳（piDesktop.isDesktop 或 Electron UA）且
 * updater 三件套齐全。旧版桌面壳（#180 之前）没有 updater —— 面板此时
 * 只给下载页指引，不画更新按钮（isBridgeUsable=false + isDesktop=true）。
 */
export function getDesktopUpdaterBridge(win?: unknown): DesktopUpdaterBridge | null {
	if (!isDesktopShell(win)) return null;
	const w =
		(win as DesktopShellWindow | undefined) ??
		(typeof window === "undefined" ? undefined : (window as unknown as DesktopShellWindow));
	const updater = (w as { piDesktop?: { updater?: DesktopUpdaterBridge } } | undefined)?.piDesktop?.updater;
	if (!updater || typeof updater.check !== "function" || typeof updater.download !== "function") return null;
	return updater;
}

function invokeMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** 主进程 status() 的返回值 → 事件（字段不认识就当作没有）。 */
function asUpdaterEvent(v: unknown): DesktopUpdaterEvent | null {
	if (!v || typeof v !== "object") return null;
	const state = (v as { state?: unknown }).state;
	if (typeof state !== "string") return null;
	return v as DesktopUpdaterEvent;
}

/**
 * 去下载页：有远端版本号就直达该 tag（`…/releases/tag/vX.Y.Z`），
 * 还没结论就落到 `…/releases/latest`。永远有地方可去，不 404。
 */
export function desktopReleasesUrl(version: string | null | undefined): string {
	const v = (version ?? "").trim().replace(/^v/, "");
	return v
		? `https://github.com/${DESKTOP_REPO}/releases/tag/v${v}`
		: `https://github.com/${DESKTOP_REPO}/releases/latest`;
}

// -- 模块级单例状态（设置面板开关即卸载，状态不能挂在组件上） --------------------

let currentStatus: DesktopUpdaterStatus = INITIAL_DESKTOP_UPDATER_STATUS;
const statusListeners = new Set<(s: DesktopUpdaterStatus) => void>();
/** 主进程事件订阅只绑一次（进程生命周期内），不随组件挂载/卸载反复订阅。 */
let bridgeBound = false;
/** 首次订阅时是否已向主进程补过历史事件（旧桌面壳没有 status 通道 → 只试一次）。 */
let statusHydrated = false;

function setStatus(next: DesktopUpdaterStatus): void {
	currentStatus = next;
	for (const cb of statusListeners) cb(next);
}

function patchStatus(fn: (prev: DesktopUpdaterStatus) => DesktopUpdaterStatus): void {
	setStatus(fn(currentStatus));
}

/** 当前更新状态（非 React 环境也能读，便于单测与主进程推送后即时取用）。 */
export function getDesktopUpdaterStatus(): DesktopUpdaterStatus {
	return currentStatus;
}

/** 订阅状态变化（返回退订函数）。 */
export function subscribeDesktopUpdater(cb: (s: DesktopUpdaterStatus) => void): () => void {
	statusListeners.add(cb);
	bindBridge();
	return () => {
		statusListeners.delete(cb);
	};
}

/** 把主进程事件接进单例（幂等；无桥/旧壳直接跳过）。 */
function bindBridge(): void {
	if (bridgeBound) return;
	const bridge = getDesktopUpdaterBridge();
	if (!bridge) return;
	bridgeBound = true;
	bridge.onEvent((msg) => patchStatus((prev) => reduceUpdaterEvent(prev, msg)));
	if (!statusHydrated && typeof bridge.status === "function") {
		statusHydrated = true;
		// 启动检查的事件可能早于本模块的订阅（设置面板按需挂载）：补一次。
		void bridge
			.status()
			.then((v) => {
				const ev = asUpdaterEvent(v);
				if (ev) patchStatus((prev) => reduceUpdaterEvent(prev, ev));
			})
			.catch(() => {
				/* 旧壳/通道异常：没有历史事件可补，静默 */
			});
	}
}

/** 触发一次检查（失败落成 error 状态）。 */
export function checkDesktopUpdater(): void {
	const bridge = getDesktopUpdaterBridge();
	if (!bridge) return;
	patchStatus((prev) => ({ ...prev, state: "checking", message: null }));
	void bridge.check().catch((err: unknown) => {
		patchStatus((prev) => ({ ...prev, state: "error", message: invokeMessage(err) }));
	});
}

/** 开始下载（失败落成 error 状态）。 */
export function downloadDesktopUpdater(): void {
	const bridge = getDesktopUpdaterBridge();
	if (!bridge) return;
	patchStatus((prev) => ({ ...prev, state: "downloading", message: null }));
	void bridge.download().catch((err: unknown) => {
		patchStatus((prev) => ({ ...prev, state: "error", message: invokeMessage(err) }));
	});
}

/** 退出并安装（失败落成 error 状态）。 */
export function quitAndInstallDesktopUpdater(): void {
	const bridge = getDesktopUpdaterBridge();
	if (!bridge) return;
	void bridge.quitAndInstall().catch((err: unknown) => {
		patchStatus((prev) => ({ ...prev, state: "error", message: invokeMessage(err) }));
	});
}

/** 通知主进程「自动更新」开关（落盘由 server 的 set_settings 负责；旧壳没有该通道则跳过）。 */
export function setDesktopAutoUpdate(enabled: boolean): void {
	const bridge = getDesktopUpdaterBridge();
	if (!bridge || typeof bridge.setAuto !== "function") return;
	void bridge.setAuto(enabled).catch(() => {
		/* 偏好同步失败不影响使用（主进程下一轮启动仍从 client-state.json 读） */
	});
}

/** 设置面板用的 hook：读单例状态 + 订阅变化（组件开关不丢进度）。 */
export function useDesktopUpdater(): DesktopUpdaterStatus & {
	bridge: DesktopUpdaterBridge | null;
	check: () => void;
	download: () => void;
	quitAndInstall: () => void;
} {
	const [status, setLocalStatus] = useState<DesktopUpdaterStatus>(getDesktopUpdaterStatus);

	useEffect(() => subscribeDesktopUpdater(setLocalStatus), []);

	return {
		...status,
		bridge: getDesktopUpdaterBridge(),
		check: checkDesktopUpdater,
		download: downloadDesktopUpdater,
		quitAndInstall: quitAndInstallDesktopUpdater,
	};
}
