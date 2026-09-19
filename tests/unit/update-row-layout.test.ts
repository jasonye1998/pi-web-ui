// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { UpdatesPanel } from "../../web/src/components/UpdatesPanel.js";
import { resetAppGlobals, setAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { LanguageProvider } from "../../web/src/i18n.js";

/**
 * w9: outdated update rows show `[button] <name> v123 -> v125`.
 * w10: the wrapped second line shows `[kind v123 -> v125]` right-aligned.
 *
 * The per-row Update button used to render AFTER the version span, so on
 * narrow panels the name (flex:1, min-width:0) collapsed to nothing and the
 * row showed only the version change plus a trailing button. The button now
 * renders FIRST in DOM order for outdated rows, and warn rows wrap the
 * kind + version meta as one unit onto a second line instead of hiding the
 * name. The meta carries margin-left: auto so the second line sits right
 * while button + name stay left on the first line.
 *
 * PR4 moved these rows out of the top-bar update dropdown into the Settings →
 * "更新" page (web/src/components/UpdatesPanel.tsx), so the harness renders
 * that component directly. The assertions are unchanged.
 *
 * Zero token / zero port: true jsdom + true React render, DOM order asserts.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web", "src", "styles.css"), "utf8");

const updatesAll = [
	{ name: "demo-ext", kind: "package", current: "123", latest: "125", upToDate: false },
	{ name: "steady-ext", kind: "package", current: "10", latest: "10", upToDate: true },
	{ name: "broken-ext", kind: "package", current: "1", latest: null, upToDate: false, error: "nope" },
] as const;

let root: Root | null = null;

function mount(onSend?: (msg: unknown) => void) {
	if (onSend) setAppSend(onSend as Parameters<typeof setAppSend>[0]);
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(UpdatesPanel, {
					update: null,
					updatesAll: updatesAll as unknown as Parameters<typeof UpdatesPanel>[0]["updatesAll"],
					autoUpdate: false,
					onAutoUpdateChange: () => {},
					onRunTerminalCommand: () => {},
				}),
			),
		);
	});
	return container;
}

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	resetAppGlobals();
	setAppSend(null);
});

describe("UpdatesPanel · 受管实例（PI_WEB_MANAGED=1）", () => {
	it("只留一句说明：不画更新入口、不发检查消息", () => {
		localStorage.setItem("pi-web-ui:lang", "zh");
		const sent: string[] = [];
		setAppGlobals({ managed: true });
		const container = mount((msg) => sent.push((msg as { type: string }).type));
		expect(container.querySelector(".upd-app")).toBeNull();
		expect(container.querySelector(".dd-updates-all")).toBeNull();
		expect(container.querySelector(".set-note")?.textContent).toContain("部署方管理");
		expect(sent).toEqual([]);
	});
});

describe("w10 update row layout", () => {
	it("outdated row: update button is the leftmost (first) DOM child", () => {
		const container = mount();
		const rows = Array.from(container.querySelectorAll("li.dd-all-item.warn")).filter((li) =>
			li.querySelector("button.dd-update-btn"),
		);
		expect(rows.length).toBeGreaterThan(0);
		for (const li of rows) {
			expect(li.firstElementChild?.tagName).toBe("BUTTON");
			expect(li.firstElementChild?.classList.contains("dd-update-btn")).toBe(true);
		}
	});

	it("outdated row child order: button, name, meta(kind, version)", () => {
		const container = mount();
		const row = Array.from(container.querySelectorAll("li.dd-all-item.warn")).find((li) =>
			li.querySelector("button.dd-update-btn"),
		)!;
		const order = Array.from(row.children).map((el) =>
			el.classList.contains("dd-update-btn") ? "button" : el.className.split(" ").find((c) => c.startsWith("dd-all-")),
		);
		expect(order).toEqual(["button", "dd-all-name", "dd-all-meta"]);
		const meta = row.querySelector(":scope > .dd-all-meta")!;
		const metaOrder = Array.from(meta.children).map((el) =>
			el.className.split(" ").find((c) => c.startsWith("dd-all-")),
		);
		expect(metaOrder).toEqual(["dd-all-kind", "dd-all-vers"]);
	});

	it("accessible DOM order stays button, name, kind, version", () => {
		const container = mount();
		const row = Array.from(container.querySelectorAll("li.dd-all-item.warn")).find((li) =>
			li.querySelector("button.dd-update-btn"),
		)!;
		const flat = Array.from(row.querySelectorAll("button.dd-update-btn, .dd-all-name, .dd-all-kind, .dd-all-vers"));
		expect(
			flat.map((el) =>
				el.tagName === "BUTTON"
					? "button"
					: (el as HTMLElement).className.split(" ").find((c) => c.startsWith("dd-all-")),
			),
		).toEqual(["button", "dd-all-name", "dd-all-kind", "dd-all-vers"]);
	});

	it("no CSS pushes the row button right (order / margin-left / float / absolute)", () => {
		const btnBlock = CSS.match(/\.dd-update-btn\s*\{[^}]*\}/s)?.[0] ?? "";
		expect(btnBlock).not.toMatch(/^\s*order\s*:/m);
		expect(btnBlock).not.toMatch(/margin-left\s*:\s*auto/);
		expect(btnBlock).not.toMatch(/float\s*:/);
		expect(btnBlock).not.toMatch(/position\s*:\s*(absolute|fixed)/);
	});

	it("warn rows wrap so the meta drops to a second line, name keeps a floor width", () => {
		const warnBlock = CSS.match(/\.dd-all-item\.warn\s*\{[^}]*\}/s)?.[0] ?? "";
		expect(warnBlock).toMatch(/flex-wrap\s*:\s*wrap/);
		const nameBlock = CSS.match(/\.dd-all-item\.warn\s+\.dd-all-name\s*\{[^}]*\}/s)?.[0] ?? "";
		expect(nameBlock).toMatch(/min-width\s*:/);
	});

	it("wrapped second line: kind first, kind + version right-aligned via meta", () => {
		const metaBlock = CSS.match(/\.dd-all-meta\s*\{[^}]*\}/s)?.[0] ?? "";
		expect(metaBlock).toMatch(/display\s*:\s*flex/);
		expect(metaBlock).toMatch(/flex-shrink\s*:\s*0/);
		expect(metaBlock).not.toMatch(/position\s*:\s*(absolute|fixed)/);
		expect(metaBlock).not.toMatch(/^\s*order\s*:/m);
		const warnMetaBlock = CSS.match(/\.dd-all-item\.warn\s+\.dd-all-meta\s*\{[^}]*\}/s)?.[0] ?? "";
		expect(warnMetaBlock).toMatch(/margin-left\s*:\s*auto/);
		expect(warnMetaBlock).not.toMatch(/position\s*:\s*(absolute|fixed)/);
	});
});
