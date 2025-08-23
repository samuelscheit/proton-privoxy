import { spawn, spawnSync } from "child_process";
import { promises as fs, existsSync, readFileSync } from "fs";
import path from "path";
import net from "net";
import { URL } from "url";
import dns from "dns";
import { resetCredentials } from "./browser.ts";

process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);

interface TunnelInfo {
	index: number; // sequential index
	configPath: string; // absolute path to ovpn
	configName: string; // basename
	port: number; // local proxy listening port
	devName: string; // tun device name (tun0, tun1,...)
	interfaceIp?: string; // assigned IPv4 of tun device
}

const ENV = process.env;
const AUTH_FILE_PATH = "/etc/openvpn/auth.txt";
const OVPN_CONFIG_DIR = "/etc/openvpn/configs";
const OPENVPN_BASE_LOG_DIR = "/tmp/multi_ovpn_logs";
const BASE_PORT = intFromEnv("BASE_PROXY_PORT", 8100); // rotating proxy port
const MAX_CONNECTIONS = intFromEnv("MAX_CONNECTIONS", 0);
const DNS_SERVERS_OVERRIDE = (ENV.DNS_SERVERS_OVERRIDE || "").trim();
const START_PORT_GAP = intFromEnv("PORT_GAP", 1); // increment between proxy ports
const CONNECT_BACKLOG = intFromEnv("PROXY_BACKLOG", 128);
const TUN_IP_WAIT_MS = intFromEnv("TUN_IP_WAIT_MS", 15000); // wait after openvpn launch
const REQUIRE_TUN_IP = boolFromEnv("REQUIRE_TUN_IP", true);

function intFromEnv(name: string, def: number): number {
	const v = ENV[name];
	if (!v) return def;
	const n = parseInt(v, 10);
	return Number.isFinite(n) ? n : def;
}

function boolFromEnv(name: string, def: boolean): boolean {
	const v = (ENV[name] || "").trim().toLowerCase();
	if (!v) return def;
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

async function ensureTun(): Promise<void> {
	if (existsSync("/dev/net/tun")) return;
	if (!existsSync("/dev/net")) await fs.mkdir("/dev/net", { recursive: true });
	spawnSync("mknod", ["/dev/net/tun", "c", "10", "200"]);
	spawnSync("chmod", ["0666", "/dev/net/tun"]);
	if (!existsSync("/dev/net/tun")) throw new Error("Cannot create /dev/net/tun");
}

async function ensureAuth(u = ENV.PVPN_USERNAME, p = ENV.PVPN_PASSWORD): Promise<void> {
	if (existsSync(AUTH_FILE_PATH)) return;
	if (!u || !p) throw new Error("PVPN_USERNAME/PVPN_PASSWORD required");
	await fs.writeFile(AUTH_FILE_PATH, `${u}\n${p}\n`, { mode: 0o600 });
}

async function listConfigs(): Promise<string[]> {
	const files = await fs.readdir(OVPN_CONFIG_DIR).catch(() => [] as string[]);
	const ovpn = files
		.filter((f) => f.endsWith(".ovpn"))
		.sort()
		.map((f) => path.join(OVPN_CONFIG_DIR, f));
	if (!ovpn.length) throw new Error("No ovpn configs found");
	return ovpn;
}

async function assignPorts(configs: string[]): Promise<TunnelInfo[]> {
	const out: TunnelInfo[] = [];
	// Reserve BASE_PORT for the rotating proxy; per-tunnel proxies start after the gap
	let port = BASE_PORT + START_PORT_GAP;
	let idx = 0;
	for (const cfg of configs) {
		if (MAX_CONNECTIONS && out.length >= MAX_CONNECTIONS) break;
		const devName = `tun${idx}`;
		out.push({ index: idx, configPath: cfg, configName: path.basename(cfg), port, devName });
		port += START_PORT_GAP;
		idx++;
	}
	return out;
}

async function overrideDNS(): Promise<void> {
	if (!DNS_SERVERS_OVERRIDE) return;
	const servers = DNS_SERVERS_OVERRIDE.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (!servers.length) return;
	await fs.writeFile("/etc/resolv.conf", ["# overridden", ...servers.map((s) => `nameserver ${s}`)].join("\n") + "\n");
}

function getCurrentAuth(): { username: string; password: string } {
	const content = readFileSync(AUTH_FILE_PATH, "utf-8");
	const lines = content
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length >= 2) {
		return { username: lines[0], password: lines[1] };
	}
	throw new Error("Invalid auth file format");
}

function launchOpenVPN(t: TunnelInfo) {
	const logDir = path.join(OPENVPN_BASE_LOG_DIR, t.configName);
	fs.mkdir(logDir, { recursive: true });
	const logPath = path.join(logDir, "openvpn.log");
	const startAuth = getCurrentAuth();

	const args = [
		"--config",
		t.configPath,
		"--dev",
		t.devName,
		"--auth-user-pass",
		AUTH_FILE_PATH,
		"--auth-nocache",
		"--pull-filter",
		"ignore",
		"route-ipv6",
		"--pull-filter",
		"ignore",
		"ifconfig-ipv6",
		"--pull-filter",
		"ignore",
		"redirect-gateway",
		// "--log",
		// logPath,
		"--script-security",
		"2",
	];
	const process = spawn("openvpn", args, { stdio: "pipe" });

	process.on("close", (code, signal) => {
		console.warn(`[openvpn] ${t.configName} exited with code=${code} signal=${signal}`);
	});

	process.on("error", (err) => {
		console.error(`[openvpn] ${t.configName} error: ${err?.message || err}`);
	});

	process.on("closed", () => {
		console.warn(`[openvpn] ${t.configName} closed`);
	});

	process.on("disconnect", () => {
		console.warn(`[openvpn] ${t.configName} disconnected`);
	});

	process.stderr?.on("data", (data) => {
		const msg = (data || "").toString("utf8").trim();
		if (msg) console.error(`[openvpn] ${t.configName} stderr: ${msg}`);
	});

	process.stdout?.on("data", (data) => {
		const msg = (data || "").toString("utf8").trim();
		if (msg) console.log(`[openvpn] ${t.configName} stdout: ${msg}`);
	});

	console.log(`[openvpn] launched ${t.configName} dev=${t.devName} port=${t.port} log=${logPath}`);

	return new Promise((resolve, reject) => {
		let logs = [] as string[];

		process.stdout.on("data", async (data) => {
			const lines = (data || "").toString("utf8").trim().split(/\r?\n/);
			for (const line of lines) {
				const l = line.trim();
				if (!l) continue;

				logs.push(l);

				if (l.includes("net_addr_v4_add")) {
					const ip = l.match(/((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)\.?\b){4}/);
					if (!ip) continue
					t.interfaceIp = ip[0];

				} else if (l.includes("AUTH_FAILED")) {
					const currentAuth = getCurrentAuth();
					if (currentAuth.username === startAuth.username && currentAuth.password === startAuth.password) {
						const credentials = await resetCredentials();

						await ensureAuth(credentials.username, credentials.password);
					}

					process.kill();

					return await launchOpenVPN(t).then(resolve).catch(reject);
				} else if (l.includes("Initialization Sequence Completed")) {
					resolve(t)
				}
			}
		});

		process.on("exit", (code, signal) => {
			const allLogs = logs.join("\n");
			const err = new Error(`OpenVPN process for ${t.configName} exited with code=${code} signal=${signal}\nLogs:\n${allLogs}`);
			console.error(err.message);

			launchOpenVPN(t).then(resolve).catch(reject);
		});
	});
}

async function wait(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

function createTcpProxy(t: TunnelInfo) {
	const server = net.createServer({ allowHalfOpen: false }, (client) => {
		client.once("data", (chunk) => processInitialClientData(chunk, client, () => t));
	});
	server.on("error", (e) => console.error(`Proxy ${t.configName}:${t.port} error`, e));
	// Bun sometimes mis-identifies the 4-arg overload; use 3-arg then add 'listening' event
	server.listen({ port: t.port, host: "0.0.0.0", backlog: CONNECT_BACKLOG });
	server.on("listening", () => {
		console.log(`Proxy up for ${t.configName} dev=${t.devName} port=${t.port} localAddress=${t.interfaceIp || "default"}`);
	});
}

function createRotatingProxy(port: number, tunnels: TunnelInfo[]) {
	if (!tunnels.length) return;
	let rr = 0; // round-robin index
	const pickTunnel = (): TunnelInfo | undefined => {
		if (!tunnels.length) return undefined;
		let attempts = 0;
		while (attempts < tunnels.length) {
			const t = tunnels[rr % tunnels.length];
			rr++;
			attempts++;
			if (!REQUIRE_TUN_IP || t.interfaceIp) return t;
		}
		return undefined;
	};
	const server = net.createServer({ allowHalfOpen: false }, (client) => {
		client.once("data", (chunk) => processInitialClientData(chunk, client, pickTunnel));
	});
	server.on("error", (e) => console.error(`Rotating proxy error on port ${port}`, e));
	server.listen({ port, host: "0.0.0.0", backlog: CONNECT_BACKLOG });
	server.on("listening", () => {
		console.log(`Rotating proxy up on port ${port} across ${tunnels.length} tunnels (round-robin per request)`);
	});
}

// DRY helper: parse first data chunk, determine target, and dispatch via selected tunnel.
function processInitialClientData(firstChunk: Buffer, client: net.Socket, pickTunnel: () => TunnelInfo | undefined) {
	const t = pickTunnel();
	if (!t) {
		client.destroy();
		return;
	}
	const str = firstChunk.toString("utf8");
	const first = str.split("\n")[0] || "";
	if (/^CONNECT\s+/i.test(first)) {
		const target = first.split(/\s+/)[1];
		handleConnect(target, client, firstChunk, t);
	} else if (/^[A-Z]+\s+https?:\/\//.test(first)) {
		const hostLine = str.match(/Host:\s*([^\r\n]+)/i);
		const host = hostLine?.[1];
		const urlHost = host
			? host
			: (() => {
					try {
						return new URL(first.split(/\s+/)[1]).host;
					} catch {
						return undefined;
					}
				})();
		handleConnect(`${urlHost || ""}:80`, client, firstChunk, t, true);
	} else {
		client.destroy();
	}
}

function handleConnect(target: string, client: net.Socket, firstChunk: Buffer, tunnel: TunnelInfo, isHttpForward = false) {
	// Leak protection: never forward without a bound tunnel IP
	if (REQUIRE_TUN_IP && !tunnel.interfaceIp) {
		client.destroy();
		return;
	}
	const [host, portRaw] = target.split(":");
	const port = parseInt(portRaw, 10) || 443;
	if (!host || !/^[A-Za-z0-9_.-]+$/.test(host)) {
		client.destroy();
		return;
	}

	const connectWith = (dstIp: string) => {
		// Debug: show kernel routing decision for this src/dst
		try {
			const dbg = spawnSync("sh", ["-c", `ip -4 route get ${dstIp} from ${tunnel.interfaceIp} 2>&1 | head -n1`], {
				encoding: "utf8",
			});
			const line = (dbg.stdout || dbg.stderr || "").trim();
		} catch {}

		const remote = net.connect({ host: dstIp, port, localAddress: tunnel.interfaceIp }, () => {
			const la = (remote as any).localAddress || "";
			const lp = (remote as any).localPort || "";
			const ra = (remote as any).remoteAddress || dstIp;
			const rp = (remote as any).remotePort || port;
			console.log(`[socket] local=${la}:${lp} -> remote=${ra}:${rp} (requested local=${tunnel.interfaceIp})`);
			if (isHttpForward) {
				remote.write(firstChunk);
			} else {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			}
			client.pipe(remote).pipe(client);
		});
		remote.on("error", (e) => {
			console.warn(`[socket-error] ${e?.message || e}`);
			client.destroy();
		});
	};

	// If target host is already an IP, use it directly; else resolve to IPv4 to avoid v6/v4 ambiguity
	if (net.isIP(host)) {
		connectWith(host);
	} else {
		dns.lookup(host, { family: 4 }, (err, address) => {
			if (err || !address) {
				client.destroy();
				return;
			}
			connectWith(address);
		});
	}
}

async function main() {
	console.log("-- Multi OpenVPN + TS TCP proxy (no nginx/privoxy) --");
	await ensureTun();

	const credentials = await resetCredentials()
	await ensureAuth(credentials.username, credentials.password);
	await fs.mkdir(OPENVPN_BASE_LOG_DIR, { recursive: true });
	await overrideDNS();

	const configs = await listConfigs();
	const tunnels = await assignPorts(configs);
	console.log(`Launching ${tunnels.length} openvpn tunnels`);
	const promises = tunnels.map(launchOpenVPN);

	await Promise.allSettled(promises);

	console.log(`Waiting for tunnel to connect and IP provisioning...`);
	const proxies = tunnels.map(createTcpProxy);

	createRotatingProxy(BASE_PORT, tunnels);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
