/**
 * desktop preload — 只暴露最小只读信息 + 更新通道。业务全部走 HTTP/WS，
 * 不走 IPC，避免和 web/ 现有协议分叉；唯独应用内自动更新（issue #180）是
 * 主进程（electron-updater）的事，server sidecar 够不着，所以单开这几个
 * invoke（check/download/quit-install/set-auto/status）+ 一个 event 订阅。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

/** 与 desktop/main.ts 的 DesktopUpdaterEvent 同构（JSON 过 IPC，字段只增不改）。 */
export interface DesktopUpdaterEvent {
	state: "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error";
	version?: string | null;
	percent?: number;
	message?: string;
}

contextBridge.exposeInMainWorld("piDesktop", {
	isDesktop: true as const,
	versions: {
		electron: process.versions.electron,
		chrome: process.versions.chrome,
		node: process.versions.node,
	} as const,
	updater: {
		check: () => ipcRenderer.invoke("pi-desktop-updater:check"),
		download: () => ipcRenderer.invoke("pi-desktop-updater:download"),
		quitAndInstall: () => ipcRenderer.invoke("pi-desktop-updater:quit-install"),
		/** 自动更新开关（默认关）：落盘由 server 的 set_settings 负责，这里只通知主进程。 */
		setAuto: (enabled: boolean) => ipcRenderer.invoke("pi-desktop-updater:set-auto", enabled === true),
		/** 最近一条更新事件（null = 还没收到过）：设置面板晚于启动检查挂载时用它补齐。 */
		status: () => ipcRenderer.invoke("pi-desktop-updater:status"),
		onEvent: (cb: (msg: DesktopUpdaterEvent) => void) => {
			const listener = (_event: IpcRendererEvent, msg: DesktopUpdaterEvent) => cb(msg);
			ipcRenderer.on("pi-desktop-updater:event", listener);
			return () => ipcRenderer.removeListener("pi-desktop-updater:event", listener);
		},
	},
});
