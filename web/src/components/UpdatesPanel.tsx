import { useEffect, useState } from "react";
import { FiAlertTriangle, FiDownload, FiRefreshCw } from "react-icons/fi";
import { useT } from "../i18n";
import { appSend, useAppField, useAppGlobals, useIsManaged, useServiceInfo } from "../app-globals";
import { appUrl } from "../base-url";
import { buildUpdateCommand } from "../update-command";
import type { UpdateAllItem } from "../use-chat";
import { isDesktopShell } from "../desktop";
import {
	checkDesktopUpdater,
	desktopReleasesUrl,
	downloadDesktopUpdater,
	getDesktopUpdaterStatus,
	quitAndInstallDesktopUpdater,
	setDesktopAutoUpdate,
	useDesktopUpdater,
} from "../desktop-updater";

/**
 * 设置面板 → 「更新」页（PR4）。
 *
 * 为什么从顶栏搬到这里：更新是低频、需要解释的操作（自动更新开关、逐组件版本、
 * 重启服务），塞在顶栏下拉里既挤又要靠 ⋯ 溢出菜单才找得到。搬进设置面板后它是
 * 一个正常大小的页面，顶栏只留一个带版本号的门牌（host:update）。
 *
 * 两条更新链路在这页里汇合，各自独立：
 *  - **Web 界面 / 组件**（任何部署形态）：服务端 `check_update` / `check_updates_all`
 *    + `npm i -g` 终端命令（在可见终端里跑，见 onRunTerminalCommand）。
 *  - **桌面壳本体**（只有 Electron 里才有）：主进程 electron-updater，走 preload IPC
 *    （web/src/desktop-updater.ts 的模块级单例）。浏览器里这一段整体不画。
 *
 * 桌面状态放模块级单例而不是本组件的 state：设置面板一关就卸载，组件内 state 会让
 * 「下载到一半关掉设置再回来」退回 idle（见 desktop-updater.ts 的注释）。
 */
export function UpdatesPanel({
	update,
	updatesAll,
	autoUpdate,
	onAutoUpdateChange,
	onRunTerminalCommand,
}: {
	/** 自身版本检查结果（check_update 的回包；null = 还没回来）。 */
	update: {
		current: string;
		latest: string | null;
		latestPublishedAt: string | null;
		upToDate: boolean;
		error?: string;
	} | null;
	/** 全来源更新检查（webui + pi 核心 + 已装组件；null = 还没回来）。 */
	updatesAll: UpdateAllItem[] | null;
	/** 桌面壳「自动更新」偏好（服务端持久化，见 UiSettingsState.autoUpdate）。 */
	autoUpdate: boolean;
	onAutoUpdateChange: (enabled: boolean) => void;
	/** 在可见终端里跑一条维护命令（复用设置面板既有的 SCM 式终端流程）。 */
	onRunTerminalCommand: (title: string, command: string) => void;
}) {
	const t = useT();
	const { appVersion } = useAppGlobals();
	// 由 pi-web-ui 服务启动的实例（launchd/systemd/Windows watchdog）：退出后会被
	// supervisor 拉起，所以这里给一个「重启服务」按钮；前台/dev 实例没有值。
	const service = useServiceInfo();
	// PI_WEB_MANAGED=1：本实例由部署方更新（服务端会拒 check_update 等消息，见
	// server/managed.ts），整页只留说明 —— 与旧顶栏那条只读 chip 同口径。
	const managed = useIsManaged();
	const [restarting, setRestarting] = useState(false);
	// 「重启服务」会断开连接（进程退出→supervisor 拉起）：重新连上（open）后
	// 把按钮恢复可用，否则它会永远停在「重启中…」。
	const connStatus = useAppField("status");
	useEffect(() => {
		if (restarting && connStatus === "open") setRestarting(false);
	}, [restarting, connStatus]);
	const inDesktopShell = isDesktopShell();
	const desktopUpdater = useDesktopUpdater();

	// 进这一页就查一遍（与旧顶栏下拉「打开即查」同口径）。桌面壳的检查只在本页
	// 首次挂载且还没查过时发（主进程的事件是单例状态，重开设置不该把结果冲掉）。
	useEffect(() => {
		if (managed) return;
		appSend({ type: "check_update" });
		appSend({ type: "check_updates_all" });
		if (inDesktopShell && getDesktopUpdaterStatus().state === "idle") checkDesktopUpdater();
		// 只在挂载时跑一次：依赖项变化（状态更新）不该再发一遍检查。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	/** 统一状态：桌面壳看主进程事件，浏览器从自身版本检查推导。 */
	type StatusKind = "idle" | "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error";
	const status: StatusKind = inDesktopShell
		? desktopUpdater.state
		: update === null
			? "checking"
			: update.error
				? "error"
				: update.upToDate
					? "up-to-date"
					: "available";
	const busy = status === "checking" || status === "downloading";
	const version = appVersion ?? update?.current ?? "…";
	const latestVersion = inDesktopShell ? (desktopUpdater.version ?? update?.latest ?? null) : (update?.latest ?? null);
	const statusText: string =
		status === "idle"
			? t("updNotChecked")
			: status === "checking"
				? inDesktopShell
					? t("updateDesktopChecking")
					: t("checkingUpdate")
				: status === "available"
					? t("updateAvailable", { version: latestVersion ?? "" })
					: status === "up-to-date"
						? t("upToDate")
						: status === "downloading"
							? t("updateDesktopDownloading", { n: desktopUpdater.percent })
							: status === "downloaded"
								? t("updateDesktopDownloaded")
								: inDesktopShell
									? t("updateDesktopError", { error: desktopUpdater.message ?? "" })
									: t("updateCheckFailed");
	const statusClass =
		status === "up-to-date"
			? " ok"
			: status === "downloaded"
				? " ok"
				: status === "available" || status === "downloading"
					? " warn"
					: status === "error"
						? " err"
						: "";
	const manualUrl = desktopReleasesUrl(latestVersion);
	const manual = (
		<a className="dd-refresh dd-more-link" href={manualUrl} target="_blank" rel="noreferrer noopener">
			{t("updateDesktopManual")}
		</a>
	);
	// 旧桌面壳（#180 之前）没有 updater 桥：只给下载页指引，不画应用内更新按钮。
	const desktopBridgeMissing = inDesktopShell && !desktopUpdater.bridge;
	// 桌面壳里 npm 全局包与包内服务无关（服务随应用发布）：不画终端更新那条路。
	const showTerminalUpdate = !inDesktopShell && !!update && !update.upToDate && !!update.latest;

	const allItems = updatesAll ?? [];
	// 纯报错不算「有更新」（它们单独以失败行展示）。
	const updatesCount = allItems.filter((i) => !i.upToDate && !i.error).length;
	// 有真实新版本的组件（pi 核心 + 全局包）：逐行「更新」与「全部更新」的目标。
	// Web 界面自身排除在外 —— 它在上面有自己那条更新路径。
	const updatable = allItems.filter((i) => !i.upToDate && !i.error && i.kind !== "webui");
	// git 源的行显示 `host/path`（用户在 settings.json 里写、`pi update` 也吃这个），
	// 而不是 clone 出来的 package.json 名字（往往是通用名、认不出是谁）。
	const gitDisplayName = (item: UpdateAllItem) =>
		item.kind === "git-extension" && item.source ? item.source : item.name;
	const gitNameTitle = (item: UpdateAllItem) =>
		item.kind === "git-extension" && item.source && item.source !== item.name
			? `${item.source} (${item.name})`
			: item.name;
	// git SHA 对用户没有信息量（`0.1.0 (aaa → bbb)`）：版本列里隐掉，落后与否已由
	// warn 底色 + 更新按钮表达；完整值留在 tooltip 里。
	const stripGitSha = (v: string) => {
		const s = v.replace(/ \([0-9a-f]{7}\)$/, "");
		return /^[0-9a-f]{7}$/.test(s) ? "" : s;
	};
	const shortGitRange = (current: string, latest: string | null) => {
		if (!latest) return stripGitSha(current);
		const c = stripGitSha(current);
		const l = stripGitSha(latest);
		return c === l ? c : `${c} → ${l}`;
	};

	if (managed) {
		return (
			<div className="set-section">
				<div className="set-section-title">
					<FiDownload className="set-section-icon" />
					{t("update")}
				</div>
				<div className="set-note">{t("updatesManaged")}</div>
			</div>
		);
	}

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiDownload className="set-section-icon" />
				{t("update")}
				{updatesCount > 0 && <span className="set-count">{t("updatesAllBadge", { n: updatesCount })}</span>}
			</div>

			{/* 应用本体：图标 + 名称 + 当前版本 + 状态徽标 */}
			<div className="upd-app">
				<img className="upd-app-icon" src={appUrl("/icons/icon-192.png")} alt="" width={36} height={36} />
				<div className="upd-app-meta">
					<span className="upd-app-name">pi-web-ui</span>
					<span className="upd-app-version">
						{t("currentVersion")} v{version}
					</span>
				</div>
				<span className={`upd-status${statusClass}${busy ? " busy" : ""}`}>
					<span className="upd-status-dot" aria-hidden="true" />
					{statusText}
				</span>
			</div>

			{/* 下载进度条：只在真的在下载（或刚下完）时出现，平时不占地方。 */}
			{(status === "downloading" || status === "downloaded") && (
				<div
					className="upd-bar"
					role="progressbar"
					aria-valuenow={desktopUpdater.percent}
					aria-valuemin={0}
					aria-valuemax={100}
				>
					<div
						className="upd-bar-fill"
						style={{ width: `${status === "downloaded" ? 100 : desktopUpdater.percent}%` }}
					/>
				</div>
			)}

			{update?.latestPublishedAt && Date.now() - new Date(update.latestPublishedAt).getTime() < 30 * 60_000 && (
				<div className="dd-note warn">{t("updateJustPublished", { version: update.latest ?? "" })}</div>
			)}

			{desktopBridgeMissing && <div className="dd-note warn">{t("updateDesktopNoBridge")}</div>}

			<div className="upd-actions">
				<button
					type="button"
					className="dd-refresh accent"
					disabled={busy}
					onClick={() => {
						if (inDesktopShell) checkDesktopUpdater();
						else appSend({ type: "check_update" });
					}}
				>
					<FiRefreshCw />
					{status === "checking" ? t("checkingUpdate") : t("checkUpdate")}
				</button>
				{/* 桌面壳：可用 → 下载；已下载 → 安装并重启。浏览器：终端里 npm 更新。 */}
				{inDesktopShell && !desktopBridgeMissing && status === "available" && (
					<button type="button" className="dd-refresh accent" onClick={downloadDesktopUpdater}>
						{t("updateDesktopDownload")}
					</button>
				)}
				{inDesktopShell && !desktopBridgeMissing && status === "downloaded" && (
					<button type="button" className="dd-refresh accent" onClick={quitAndInstallDesktopUpdater}>
						{t("updateDesktopInstall")}
					</button>
				)}
				{showTerminalUpdate && (
					<button
						type="button"
						className="dd-refresh accent"
						onClick={() => onRunTerminalCommand(t("updateTabTitle"), "npm i -g pi-web-ui@latest")}
					>
						{t("updateNow")}
					</button>
				)}
				{service && (
					<button
						type="button"
						className="dd-refresh accent"
						disabled={restarting}
						title={t("restartServiceTip", { name: service.name })}
						onClick={() => {
							if (restarting) return;
							setRestarting(true);
							appSend({ type: "restart_service" });
						}}
					>
						{restarting ? t("restartingService") : t("restartService")}
					</button>
				)}
				{manual}
			</div>

			{showTerminalUpdate && <p className="set-hint">{t("updateTerminalHint")}</p>}
			{/* 桌面壳：与浏览器同理，只在确实查出有新版本时才解释「为什么要走应用内更新」。
			   未检查 / 已最新时这条说明没有意义（旧版顶栏下拉也是这个口径）。 */}
			{inDesktopShell && !desktopBridgeMissing && !!update && !update.upToDate && !!update.latest && (
				<p className="set-hint">{t("updateDesktopNote")}</p>
			)}

			{/* ---- 自动更新（桌面壳专属偏好） -------------------------------- */}
			<div className="upd-auto">
				<div className="set-row">
					<div className="set-row-info">
						<div className="set-row-name">{t("updAutoUpdate")}</div>
						<div className="set-row-desc">{t("updAutoUpdateHint")}</div>
					</div>
					{inDesktopShell && !desktopBridgeMissing && (
						<button
							type="button"
							className={`set-switch ${autoUpdate ? "on" : ""}`}
							role="switch"
							aria-checked={autoUpdate}
							title={autoUpdate ? t("settingsEnabled") : t("settingsDisabled")}
							onClick={() => {
								const next = !autoUpdate;
								onAutoUpdateChange(next);
								// 偏好落盘走服务端 set_settings（见 SettingsModal 的 setPartial），
								// 主进程那侧另走 IPC：它要立刻改 autoDownload 并在必要时马上开始下载。
								setDesktopAutoUpdate(next);
							}}
						>
							<span className="set-switch-knob" />
						</button>
					)}
				</div>
				{/* 浏览器部署没有开关可给：说明放行下（与上面的 set-hint 同口径），
				    不再与左侧说明争宽度。 */}
				{(!inDesktopShell || desktopBridgeMissing) && <p className="set-hint">{t("updDesktopOnly")}</p>}
				{inDesktopShell && !desktopBridgeMissing && autoUpdate && (
					<p className="set-hint">
						<FiAlertTriangle className="upd-warn-icon" />
						{t("updAutoInstallWarn")}
					</p>
				)}
			</div>

			{/* ---- 全部组件（webui + pi 核心 + 全局包） --------------------- */}
			<div className="dd-updates-all">
				<div className="dd-header">{t("updatesAllTitle")}</div>
				{updatesAll === null ? (
					<div className="dd-note">{t("checkingUpdate")}</div>
				) : allItems.length === 0 ? (
					<div className="dd-note">{t("updatesAllUpToDate")}</div>
				) : (
					<ul className="dd-all-list">
						{allItems.map((item) => (
							<li
								key={`${item.kind}:${item.name}`}
								className={`dd-all-item${item.error ? " err" : item.upToDate ? "" : " warn"}`}
							>
								{item.kind !== "webui" && !item.upToDate && !item.error && (
									<button
										type="button"
										className="dd-update-btn"
										onClick={() =>
											onRunTerminalCommand(t("updatePkgTabTitle", { name: item.name }), buildUpdateCommand([item]))
										}
									>
										{t("updateBtn")}
									</button>
								)}
								<span className="dd-all-name" title={gitNameTitle(item)}>
									{gitDisplayName(item)}
								</span>
								<span className="dd-all-meta">
									<span className="dd-all-kind">
										{item.kind === "webui"
											? t("kindWebUi")
											: item.kind === "pi-core"
												? t("kindPiCore")
												: item.kind === "git-extension"
													? t("kindGitExtension")
													: t("kindPackage")}
									</span>
									<span
										className="dd-all-vers"
										title={
											item.error
												? item.error
												: item.kind === "git-extension"
													? item.upToDate
														? item.current
														: `${item.current} → ${item.latest}`
													: undefined
										}
									>
										{item.error ? (
											t("updateCheckFailed")
										) : item.kind === "git-extension" ? (
											item.upToDate ? (
												stripGitSha(item.current)
											) : (
												shortGitRange(item.current, item.latest)
											)
										) : item.upToDate ? (
											`v${item.current}`
										) : (
											<>
												v{item.current} → v{item.latest}
											</>
										)}
									</span>
								</span>
							</li>
						))}
					</ul>
				)}
				<div className="dd-actions">
					{updatable.length > 0 && (
						<button
							type="button"
							className="dd-refresh accent"
							style={{ flex: 1 }}
							onClick={() => onRunTerminalCommand(t("updateAllTabTitle"), buildUpdateCommand(updatable))}
						>
							{t("updateAllBtn")}
						</button>
					)}
					<button
						type="button"
						className="dd-refresh"
						style={updatable.length > 0 ? { flex: 1 } : undefined}
						onClick={() => appSend({ type: "check_updates_all", force: true })}
					>
						{t("updatesAllRefresh")}
					</button>
				</div>
			</div>
		</div>
	);
}
