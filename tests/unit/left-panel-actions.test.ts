// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { LeftPanel, pickFillSection, pickUncappedSections } from "../../web/src/components/LeftPanel.js";
import { joinProjectPath, isValidProjectName, parentOf, MACHINE_ROOT } from "../../web/src/components/ProjectPicker.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";

let root: Root | null = null;

/** 内存 localStorage：某些 jsdom/CI 环境的存储不可写，桩掉以保证语言确定为中文。 */
function stubZhStorage() {
	const store = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
	} as unknown as Storage);
	localStorage.setItem("pi-web-ui:lang", "zh");
}

function mountLeftPanel(overrides: Record<string, unknown> = {}) {
	stubZhStorage();
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const sent: unknown[] = [];
	const panelSend = (msg: unknown) => {
		sent.push(msg);
		return true;
	};
	const props = {
		active: true,
		sessionFile: null,
		conversations: [],
		elsewhere: [],
		sessions: [
			{
				path: "session-1.jsonl",
				name: "Test Session",
				firstMessage: "Hello",
				modified: Date.now(),
				messageCount: 1,
			},
		],
		projects: [],
		activeConversationId: "",
		panelSend,
		pathCompletions: [
			{ name: "sub1", path: "/test/sub1", type: "dir" as const },
			{ name: "sub2", path: "/test/sub2", type: "dir" as const },
			{ name: "file.txt", path: "/test/file.txt", type: "file" as const },
		],
		...overrides,
	};
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				createElement(LeftPanel as any, props),
			),
		);
	});
	return { container, sent };
}

afterEach(() => {
	vi.unstubAllGlobals();
	resetAppGlobals();
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("LeftPanel 标题栏操作与项目管理", () => {
	it("projects=[] 时仍渲染“最近项目”标题栏和项目管理按钮，且不渲染项目滚动区", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: [] });

		// 标题栏存在
		const projectsSection = container.querySelector(".panel-projects");
		expect(projectsSection).toBeTruthy();
		expect(projectsSection?.textContent).toContain("最近项目");

		// 项目管理按钮存在
		const projectActionBtn = container.querySelector(".lp-project-action");
		expect(projectActionBtn).toBeTruthy();

		// 空项目区不渲染 .projects-scroll
		expect(container.querySelector(".projects-scroll")).toBeNull();
	});

	it("左栏底部常驻新对话按钮，点击后发送 new_chat 且不影响折叠状态", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container, sent } = mountLeftPanel();

		const newChatBtn = container.querySelector<HTMLButtonElement>(".lp-new-chat-action");
		expect(newChatBtn).toBeTruthy();
		expect(newChatBtn?.title).toBeTruthy();
		expect(newChatBtn?.getAttribute("aria-label")).toBeTruthy();
		expect(newChatBtn?.textContent).toContain("新对话");

		// 位于滚动区之外：不在任何一个 .lp-section 里面（否则会被列表挤走/随列表滚动）
		expect(newChatBtn?.closest(".lp-section")).toBeNull();
		// 是面板的直接子节点，且排在所有区之后（底部）
		const panel = container.querySelector(".lp-panel")!;
		const sections = Array.from(panel.querySelectorAll(":scope > .lp-section"));
		expect(sections.length).toBeGreaterThan(0);
		expect(newChatBtn?.parentElement).toBe(panel);
		expect(
			sections[sections.length - 1]!.compareDocumentPosition(newChatBtn!) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		// 旧的标题栏加号已移除：任何 .lp-section-header 内都不应再有新对话入口
		const headerBtns = Array.from(
			container.querySelectorAll<HTMLButtonElement>(".lp-section-header .lp-new-chat-action"),
		);
		expect(headerBtns).toHaveLength(0);

		const sessionsSection = container.querySelector(".panel-sessions");
		const wasCollapsed = sessionsSection?.classList.contains("collapsed");

		// 点击按钮
		sent.length = 0;
		act(() => newChatBtn!.click());
		expect(sent).toEqual([{ type: "new_chat" }]);
		expect(sessionsSection?.classList.contains("collapsed")).toBe(wasCollapsed);
	});

	it("标题行容器与折叠按钮不产生嵌套 button（无 button button）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: [] });

		// 保证没有嵌套按钮
		const nestedButtons = container.querySelectorAll("button button");
		expect(nestedButtons.length).toBe(0);
	});

	it("点击项目管理按钮打开项目管理面板，点击遮罩或按 Escape 键可关闭", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({ projects: [] });

		const projectActionBtn = container.querySelector<HTMLButtonElement>(".lp-project-action");
		expect(projectActionBtn).toBeTruthy();

		// 点击打开项目管理面板
		act(() => projectActionBtn!.click());
		const dialog = container.querySelector("[role=dialog]");
		expect(dialog).toBeTruthy();

		// 按 Escape 键关闭
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(container.querySelector("[role=dialog]")).toBeNull();

		// 再次打开并点击遮罩关闭
		act(() => projectActionBtn!.click());
		expect(container.querySelector("[role=dialog]")).toBeTruthy();
		const backdrop = container.querySelector(".status-cwd-backdrop, .project-picker-backdrop");
		expect(backdrop).toBeTruthy();
		act(() => (backdrop as HTMLElement).click());
		expect(container.querySelector("[role=dialog]")).toBeNull();
	});

	it("项目管理面板：非法项目名称（空或含分隔符）不能发送创建消息，合法名称发送 make_dir(setAsCwd: true)", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container, sent } = mountLeftPanel({ projects: [] });

		const projectActionBtn = container.querySelector<HTMLButtonElement>(".lp-project-action");
		act(() => projectActionBtn!.click());

		// 展开新建项目输入框
		const newBtn = container.querySelector<HTMLButtonElement>(".cwd-newbtn, .project-picker-newbtn");
		expect(newBtn).toBeTruthy();
		act(() => newBtn!.click());

		const input = container.querySelector<HTMLInputElement>(".cwd-newrow input, .project-picker-newrow input");
		expect(input).toBeTruthy();
		const createBtn = container.querySelector<HTMLButtonElement>(
			".cwd-newrow button.primary, .project-picker-newrow button.primary",
		);
		expect(createBtn).toBeTruthy();

		// 空名称点击
		sent.length = 0;
		act(() => createBtn!.click());
		expect(sent.filter((m: any) => m.type === "make_dir")).toHaveLength(0);

		// 包含路径分隔符
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "foo/bar");
			input!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => createBtn!.click());
		expect(sent.filter((m: any) => m.type === "make_dir")).toHaveLength(0);

		// 合法名称
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "my-new-project");
			input!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => createBtn!.click());
		const makeDirMsg = sent.find((m: any) => m.type === "make_dir") as any;
		expect(makeDirMsg).toBeTruthy();
		expect(makeDirMsg.setAsCwd).toBe(true);
		expect(makeDirMsg.path).toContain("my-new-project");
	});

	it("项目管理面板：选择现有目录发送 set_cwd", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container, sent } = mountLeftPanel({ projects: [] });

		const projectActionBtn = container.querySelector<HTMLButtonElement>(".lp-project-action");
		act(() => projectActionBtn!.click());

		const chooseBtns = Array.from(
			container.querySelectorAll<HTMLButtonElement>(".cwd-choose-btn, .project-picker-choose-btn"),
		);
		expect(chooseBtns.length).toBeGreaterThan(0);

		sent.length = 0;
		act(() => chooseBtns[0].click());
		const setCwdMsg = sent.find((m: any) => m.type === "set_cwd") as any;
		expect(setCwdMsg).toBeTruthy();
		expect(setCwdMsg.path).toBeTruthy();
	});

	it("joinProjectPath 纯函数正确处理 POSIX 和 Windows 根与路径拼接", () => {
		expect(joinProjectPath("/", "foo")).toBe("/foo");
		expect(joinProjectPath("/a", "b")).toBe("/a/b");
		expect(joinProjectPath("/a/", "b")).toBe("/a/b");
		expect(joinProjectPath("C:", "foo")).toBe("C:/foo");
		expect(joinProjectPath("C:/", "foo")).toBe("C:/foo");
		expect(joinProjectPath("C:\\dir", "sub")).toBe("C:/dir/sub");
	});

	it("isValidProjectName 校验项目名称合法性", () => {
		expect(isValidProjectName("my-project")).toBe(true);
		expect(isValidProjectName("  my-project  ")).toBe(true);
		expect(isValidProjectName("")).toBe(false);
		expect(isValidProjectName("   ")).toBe(false);
		expect(isValidProjectName(".")).toBe(false);
		expect(isValidProjectName("..")).toBe(false);
		expect(isValidProjectName("foo/bar")).toBe(false);
		expect(isValidProjectName("foo\\bar")).toBe(false);
	});

	it("parentOf 返回父路径或在根处返回 null", () => {
		expect(parentOf("/")).toBeNull();
		expect(parentOf(MACHINE_ROOT)).toBeNull();
		expect(parentOf("/a")).toBe("/");
		expect(parentOf("/a/b")).toBe("/a");
		expect(parentOf("/a/b/")).toBe("/a");
		expect(parentOf("C:")).toBe(MACHINE_ROOT);
		expect(parentOf("C:/")).toBe(MACHINE_ROOT);
		expect(parentOf("C:/Users")).toBe("C:/");
		expect(parentOf("C:/Users/test")).toBe("C:/Users");
	});
});

describe("左栏区高度自适应（pickFillSection / pickUncappedSections）", () => {
	const m = (key: "projects" | "convs" | "sessions", visible: boolean, collapsed: boolean) => ({
		key,
		visible,
		collapsed,
	});

	it("pickFillSection 取最后一个可见且展开的区", () => {
		expect(pickFillSection([m("projects", true, false), m("sessions", true, false)])).toBe("sessions");
		expect(pickFillSection([m("projects", true, false), m("convs", true, false), m("sessions", true, false)])).toBe(
			"sessions",
		);
	});

	it("pickFillSection 忽略不可见与折叠的区，全折叠/全不可见时返回 null", () => {
		// 末尾的 sessions 折叠 → 兜底落到 convs
		expect(pickFillSection([m("projects", true, false), m("convs", true, false), m("sessions", true, true)])).toBe(
			"convs",
		);
		// 末尾的 sessions 不可见（无历史对话）→ 兜底落到 convs
		expect(pickFillSection([m("projects", true, false), m("convs", true, false), m("sessions", false, false)])).toBe(
			"convs",
		);
		// 只剩一个展开区时，它就是兜底区
		expect(pickFillSection([m("projects", true, true), m("convs", true, false), m("sessions", true, true)])).toBe(
			"convs",
		);
		expect(pickFillSection([m("projects", true, true), m("sessions", true, true)])).toBeNull();
		expect(pickFillSection([])).toBeNull();
	});

	it("pickUncappedSections 恒包含最后一个展开区，并额外放行被拖大过的区", () => {
		const meta = [m("projects", true, false), m("convs", true, false), m("sessions", true, false)];
		// 默认权重：只有兜底区（sessions）不封顶
		expect([...pickUncappedSections(meta, { projects: 1, convs: 1, sessions: 1 })].sort()).toEqual(["sessions"]);
		// projects 被拖大（权重 > 默认 1）→ 它也不再封顶，否则拖大变成无效操作
		expect([...pickUncappedSections(meta, { projects: 2.5, convs: 1, sessions: 1 })].sort()).toEqual([
			"projects",
			"sessions",
		]);
		// 被拖小（权重 < 默认）不算「用户要求变高」，仍按内容封顶
		expect([...pickUncappedSections(meta, { projects: 0.5, convs: 1, sessions: 1 })].sort()).toEqual(["sessions"]);
		// 折叠/不可见的区即使权重大也不参与
		expect(
			[
				...pickUncappedSections([m("projects", true, true), m("sessions", true, false)], { projects: 9, sessions: 1 }),
			].sort(),
		).toEqual(["sessions"]);
	});

	it("lp-section-fill 只落在兜底区上，随折叠状态在三个区之间迁移", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const filled = (container: HTMLElement) =>
			Array.from(container.querySelectorAll<HTMLElement>(".lp-panel > .lp-section"))
				.filter((el) => el.classList.contains("lp-section-fill"))
				.map((el) =>
					el.classList.contains("panel-projects")
						? "projects"
						: el.classList.contains("panel-convs")
							? "convs"
							: "sessions",
				);

		// 三个区都展开：只有最后的 sessions 不封顶
		const a = mountLeftPanel({
			conversations: [{ id: "c1", title: "run", cwd: "/test", messageCount: 1, isStreaming: false, isSubagent: false }],
			projects: [{ path: "/test/p", name: "p", lastUsed: 1 }],
		});
		expect(filled(a.container)).toEqual(["sessions"]);
		act(() => root!.unmount());
		root = null;
		document.body.innerHTML = "";

		// sessions 折叠 → 兜底上移到 convs
		const b = mountLeftPanel({
			conversations: [{ id: "c1", title: "run", cwd: "/test", messageCount: 1, isStreaming: false, isSubagent: false }],
			projects: [{ path: "/test/p", name: "p", lastUsed: 1 }],
			uiLeftSessions: [],
		});
		const sessionsSection = b.container.querySelector<HTMLElement>(".panel-sessions")!;
		act(() => b.container.querySelector<HTMLButtonElement>(".panel-sessions .lp-section-chevron")!.click());
		expect(sessionsSection.classList.contains("collapsed")).toBe(true);
		expect(filled(b.container)).toEqual(["convs"]);
	});
});

describe("LeftPanel 会话行内嵌区", () => {
	const sectionEntry = (id: string, label: string, icon: string) => ({
		id,
		source: "host",
		slot: "leftpanel.sessions",
		label,
		kind: "action",
		icon,
		order: 10,
		align: "start",
		hidden: false,
		userOverrides: [],
		arrangedBy: [],
	});

	it("分区别名条目不进会话行（行内无 activity/clock 原文）；插件行动作正常渲染", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({
			uiLeftSessions: [
				sectionEntry("host:lp-running", "运行的对话", "activity"),
				sectionEntry("host:lp-history", "历史对话", "clock"),
				{
					id: "plug:x:go",
					source: "plugin:x",
					slot: "leftpanel.sessions",
					label: "Go",
					kind: "action",
					order: 100,
					align: "start",
					hidden: false,
					userOverrides: [],
					arrangedBy: [],
				},
			],
		});
		const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".lp-slot-btn"));
		// 只有插件那一条；分区别名两条被过滤（以前会按原文画出 activity/clock）
		expect(buttons).toHaveLength(1);
		expect(buttons[0]?.getAttribute("aria-label")).toBe("Go");
		expect(buttons.every((b) => !/activity|clock/.test(b.textContent ?? ""))).toBe(true);
	});

	it("内嵌区为空时不留 .lp-slot-sessions 占位（会话行 DOM 与旧版一致）", () => {
		setAppGlobals({ cwd: "/test", ready: true, status: "open", workspaceRoots: [] });
		const { container } = mountLeftPanel({
			uiLeftSessions: [
				sectionEntry("host:lp-projects", "最近项目", "folder"),
				sectionEntry("host:lp-running", "运行的对话", "activity"),
				sectionEntry("host:lp-history", "历史对话", "clock"),
			],
		});
		expect(container.querySelector(".lp-slot-sessions")).toBeNull();
		expect(container.querySelector(".lp-slot-btn")).toBeNull();
	});
});
