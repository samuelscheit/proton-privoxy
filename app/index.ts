import { spawn, spawnSync } from "child_process";
import { promises as fs, existsSync } from "fs";
import path from "path";
import net from "net";
import { URL } from "url";
import dns from "dns";

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

async function ensureAuth(): Promise<void> {
	if (existsSync(AUTH_FILE_PATH)) return;
	const u = ENV.PVPN_USERNAME || "";
	const p = ENV.PVPN_PASSWORD || "";
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

function launchOpenVPN(t: TunnelInfo): void {
	const logDir = path.join(OPENVPN_BASE_LOG_DIR, t.configName);
	fs.mkdir(logDir, { recursive: true });
	const logPath = path.join(logDir, "openvpn.log");
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
		"--log",
		logPath,
		"--script-security",
		"2",
		"--up",
		"/etc/openvpn/update-resolv-conf",
		"--down",
		"/etc/openvpn/update-resolv-conf",
		"--daemon",
	];
	spawn("openvpn", args, { stdio: "pipe" });
}

async function wait(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

async function collectTunnelIps(): Promise<Record<string, string>> {
	// Map devName -> IPv4 using iproute2. Try JSON first, then fall back.
	try {
		// Try: ip -j -4 address show
		const jsonOut = spawnSync("sh", ["-c", "ip -j -4 address show 2>/dev/null"], {
			encoding: "utf8",
		});
		if (jsonOut.stdout && jsonOut.stdout.trim()) {
			try {
				const parsed = JSON.parse(jsonOut.stdout);
				const map: Record<string, string> = {};
				for (const iface of parsed) {
					const name = iface?.ifname as string | undefined;
					if (!name || !/^tun\d+$/i.test(name)) continue;
					const addrs = (iface?.addr_info as any[] | undefined) || [];
					const v4 = addrs.find((a) => a?.family === "inet" && a?.local);
					if (v4?.local) map[name] = String(v4.local);
				}
				if (Object.keys(map).length) return map;
			} catch {
				// fall through to text parsing
			}
		}
		// Fallback: ip -4 -o addr show | awk to filter tun devices
		const out = spawnSync(
			"sh",
			["-c", "ip -4 -o addr show 2>/dev/null | awk '$2 ~ /^tun[0-9]+$/ {print $2, $4}'"],
			{ encoding: "utf8" }
		);
		const map: Record<string, string> = {};
		const stdout = out.stdout || "";
		if (stdout.trim()) console.log("ip addresses", stdout);
		stdout.split(/\n/).forEach((line) => {
			const [dev, cidr] = line.trim().split(/\s+/);
			if (dev && cidr) map[dev] = cidr.split("/")[0];
		});
		return map;
	} catch {
		return {};
	}
}

async function collectTunnelIpsFromLogs(tunnels: TunnelInfo[]): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const t of tunnels) {
		try {
			const logPath = path.join(OPENVPN_BASE_LOG_DIR, t.configName, "openvpn.log");
			const content = await fs.readFile(logPath, "utf8").catch(() => "");
			if (!content) continue;
			// Common OpenVPN log patterns that contain the assigned IPv4
			const patterns = [
				/net_addr_v4_add:\s*([0-9.]+)\/[0-9]+\s+dev\s+([\w-]+)/, // OpenVPN 2.5+
				/ ifconfig\s+([0-9.]+)\s+[0-9.]+/, // legacy ifconfig output
				/ local\s+IP\.addr\s*=\s*([0-9.]+)/, // occasionally present
			];
			for (const rx of patterns) {
				const m = content.match(rx);
				if (m && m[1]) {
					result[t.devName] = m[1];
					break;
				}
			}
		} catch {
			// ignore and continue
		}
	}
	return result;
}

async function waitForTunnelIps(tunnels: TunnelInfo[]): Promise<Record<string, string>> {
	const end = Date.now() + TUN_IP_WAIT_MS;
	let map: Record<string, string> = {};
	while (Date.now() < end) {
		map = await collectTunnelIps();
		const have = tunnels.filter((t) => map[t.devName]).length;
		if (have === tunnels.length) return map;
		await wait(1000);
	}
	// Last resort: try to infer from logs
	const fromLogs = await collectTunnelIpsFromLogs(tunnels);
	return Object.keys(fromLogs).length ? fromLogs : map;
}

async function tailLog(filePath: string, lines = 120): Promise<string> {
	try {
		const data = await fs.readFile(filePath, "utf8");
		const parts = data.split(/\r?\n/);
		return parts.slice(-lines).join("\n");
	} catch {
		return "";
	}
}

function ensureSourceRouting(t: TunnelInfo) {
	if (!t.interfaceIp) return;
	const table = 100 + t.index; // dedicated routing table per tunnel
	const ip = t.interfaceIp;
	// Remove any previous rule for this IP/table, then add a clean rule.
	spawnSync("sh", ["-c", `ip -4 rule del from ${ip}/32 table ${table} 2>/dev/null || true`]);
	spawnSync("sh", ["-c", `ip -4 rule add from ${ip}/32 table ${table} priority ${1000 + t.index}`]);
	// Ensure a default route via the tun device exists in that table.
	spawnSync("sh", ["-c", `ip -4 route replace default dev ${t.devName} table ${table}`]);
	console.log(`[routing] table ${table}: from ${ip}/32 -> default dev ${t.devName}`);
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
			const dbg = spawnSync("sh", ["-c", `ip -4 route get ${dstIp} from ${tunnel.interfaceIp} 2>&1 | head -n1`], { encoding: "utf8" });
			const line = (dbg.stdout || dbg.stderr || "").trim();
			console.log(`[route] src=${tunnel.interfaceIp} dst=${dstIp} -> ${line}`);
		} catch {}

		console.log("connect to ", dstIp, port, "using", tunnel.interfaceIp);
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
	await ensureAuth();
	await fs.mkdir(OPENVPN_BASE_LOG_DIR, { recursive: true });
	await overrideDNS();

	const configs = await listConfigs();
	const tunnels = await assignPorts(configs);
	console.log(`Launching ${tunnels.length} openvpn tunnels`);
	tunnels.forEach(launchOpenVPN);
	console.log(`Waiting for tunnel to connect and IP provisioning...`);
	// await wait(TUN_IP_WAIT_MS);

	// For simplicity we reuse the same detected tun IP for all proxies; advanced: map pid->iface
	const ipMap = await waitForTunnelIps(tunnels);
	tunnels.forEach((t) => {
		t.interfaceIp = ipMap[t.devName];
	});
	// Install per-tunnel source routing so each proxy egresses via its own tunX
	for (const t of tunnels) {
		if (t.interfaceIp) ensureSourceRouting(t);
	}
	const missing = tunnels.filter((t) => !t.interfaceIp).length;
	if (missing) {
		console.warn(`${missing} tunnel(s) missing IP assignment; they will use default routing.`);
		for (const t of tunnels.filter((x) => !x.interfaceIp)) {
			const logPath = path.join(OPENVPN_BASE_LOG_DIR, t.configName, "openvpn.log");
			const tail = await tailLog(logPath, 120);
			console.warn(`[${t.devName}] ${t.configName} — openvpn.log (last 120 lines):\n${tail || "(empty)"}`);
		}
		if (REQUIRE_TUN_IP) {
			console.error(`Leak protection active: refusing to start proxies because ${missing} tunnel(s) have no IP. Set REQUIRE_TUN_IP=0 to override (not recommended).`);
			process.exit(2);
		}
	}

	// Start per-tunnel proxies only when safe
	tunnels.forEach(createTcpProxy);
	// Also start a single rotating proxy on BASE_PORT selecting a different tunnel per request
	createRotatingProxy(BASE_PORT, tunnels);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
