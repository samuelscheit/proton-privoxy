import { dirname, join } from "path";
import { config } from "dotenv";
import { chromium, type Response } from "patchright";
import { readFileSync, writeFileSync } from "fs";
import debounce from "./util.ts";
import { fileURLToPath } from "url";
// import { debounce } from "lodash";
import os from "os";

const __filname = fileURLToPath(import.meta.url);
const __dirname = dirname(__filname);

config({
	path: join(__dirname, "..", ".env"),
});

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function login() {
	console.log("Starting browser...");

	const browser = await chromium.launchPersistentContext(join(__dirname, "..", ".user_data"), {
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--disable-accelerated-2d-canvas",
			"--no-first-run",
			"--no-zygote",
			"--disable-gpu",
			"--disable-software-rasterizer",
			"--remote-debugging-port=9222",
			"--remote-debugging-address=0.0.0.0",
		],
		headless: true,
		channel: "chrome",
		logger: {
			isEnabled(name, severity) {
				return true;
			},
			log(name, severity, message, args, hints) {
				console.log(`[${name}] ${message}`, ...args);
			},
		},
	});

	const page = await browser.newPage();

	try {
		const savedStorage = JSON.parse(readFileSync(join(__dirname, "..", ".user_data", "storage.json"), "utf-8"));

		if (savedStorage.cookies) {
			browser.addCookies(savedStorage.cookies);
		}

		page.on("domcontentloaded", (p) => {
			page.evaluate((s) => {
				const { localStorage, sessionStorage } = s;
				for (const [key, value] of Object.entries(localStorage || {})) {
					window.localStorage.setItem(key, value as string);
				}
				for (const [key, value] of Object.entries(sessionStorage || {})) {
					window.sessionStorage.setItem(key, value as string);
				}
			}, savedStorage);
		});
	} catch (error) {}

	const r = await page.goto("https://account.protonvpn.com/account-password", { waitUntil: "domcontentloaded" });

	console.log("Page loaded:", r?.status(), r?.statusText(), r?.url());

	try {
		var result = page.locator("section#account, #username");
		await result.waitFor({ state: "attached", timeout: 30_000 });
	} catch (error) {
		const x = await page.innerHTML("body");
		writeFileSync(join(__dirname, "..", ".user_data", "error.html"), x, "utf-8");
		await page.screenshot({ path: join(__dirname, "..", ".user_data", "screenshot.png") as any });
		throw error;
	}
	const id = await result?.evaluate((el) => el.id);

	console.log("Detected page id:", id);

	if (id === "account") return page;

	console.log("Logging into Proton account...");

	await page.type("#username", process.env.PROTON_USERNAME || "");

	await page.click("button[type=submit]");
	await page.locator("#password").waitFor({ state: "attached", timeout: 10000 });

	await page.type("#password", process.env.PROTON_PASSWORD || "");
	await page.click("button[type=submit]");

	await page.waitForNavigation();

	const s = await page.evaluate(() => {
		return JSON.stringify({
			localStorage,
			sessionStorage,
		});
	});
	const cookies = await browser.cookies();
	const storage = JSON.parse(s);
	storage.cookies = cookies;

	writeFileSync(join(__dirname, "..", ".user_data", "storage.json"), JSON.stringify(storage), "utf-8");

	console.log("Logged in to Proton account.");

	return page;
}

const pagePromise = login();

export const resetCredentials = debounce(async function resetCredentials() {
	const page = await pagePromise;

	await page.locator("section#openvpn").waitFor({ state: "attached" });

	const ovpn = page.locator("section#openvpn");
	await ovpn.waitFor({ state: "attached" });
	if (!ovpn) throw new Error("Could not find OpenVPN section");

	await ovpn.scrollIntoViewIfNeeded();

	const reset = ovpn.locator("button.button.button-medium.button-solid-norm");
	await reset.waitFor({ state: "attached", timeout: 2000 });
	if (!reset) throw new Error("Could not find Reset credentials button");

	await reset.scrollIntoViewIfNeeded();

	return new Promise<{
		username: string;
		password: string;
	}>(async (resolve) => {
		async function onResponse(response: Response) {
			if (response.url() !== "https://account.protonvpn.com/api/vpn/settings/reset") return;

			const json = await response.json();
			try {
				if (json.Error) {
					page.locator("#password").fill(process.env.PROTON_PASSWORD || "");
					await page.click(`button[type=submit][form="auth-form"]`);
					await sleep(1000)

					page.off("response", onResponse);

					resetCredentials().then(resolve).catch(console.error);
					return;
				}

				const { Name, Password } = json.VPNSettings;

				console.log("New OpenVPN credentials:", {
					username: Name,
					password: Password,
				});
				
				page.off("response", onResponse);

				resolve({
					username: Name,
					password: Password,
				});
			} catch (error) {
				console.error("Failed to parse OpenVPN credentials response:", json, error);
			}
		}

		page.on("response", onResponse);

		console.log("Resetting OpenVPN credentials...");

		await sleep(1000);

		await reset.click({});
	});
}, 1000 * 0)!;

// resetCredentials().then(console.log).catch(console.error);
