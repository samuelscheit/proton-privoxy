import { spawn, spawnSync } from "child_process";
import { promises as fs, existsSync, readFileSync } from "fs";
import path from "path";
import net from "net";
import { URL } from "url";
import dns from "dns";
import { connectViaDialer } from "./dialer.ts";
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
const DNS_SERVERS_OVERRIDE = (ENV.DNS_SERVERS_OVERRIDE || "1.1.1.1,8.8.8.8").trim();
const START_PORT_GAP = intFromEnv("PORT_GAP", 1); // increment between proxy ports
const CONNECT_BACKLOG = intFromEnv("PROXY_BACKLOG", 128);
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
	const startAuth = getCurrentAuth();

	const args = [
		"--config",
		t.configPath,
		"--dev",
		t.devName,
		"--auth-user-pass",
		AUTH_FILE_PATH,
		"--auth-nocache",
		"--float",
		"--pull-filter",
		"ignore",
		"route-ipv6",
		"--pull-filter",
		"ignore",
		"ifconfig-ipv6",
		"--pull-filter",
		"ignore",
		"dhcp-option",
		"--pull-filter",
		"ignore",
		"redirect-gateway",
		"--route-nopull",
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

	console.log(`[openvpn] launched ${t.configName} dev=${t.devName} port=${t.port}`);

	return new Promise<TunnelInfo>((resolve, reject) => {
		let logs = [] as string[];

		process.stdout.on("data", async (data) => {
			const lines = (data || "").toString("utf8").trim().split(/\r?\n/);
			for (const line of lines) {
				const l = line.trim();
				if (!l) continue;

				logs.push(l);

				console.log(`[openvpn] ${t.configName} stdout: ${line}`);

				if (l.includes("net_addr_v4_add")) {
					const ip = l.match(/((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)\.?\b){4}/);
					if (!ip) continue;
					t.interfaceIp = ip[0];
					console.log(`[openvpn] ${t.configName} assigned IP ${t.interfaceIp}`);
				} else if (l.includes("AUTH_FAILED")) {
					const currentAuth = getCurrentAuth();
					if (currentAuth.username === startAuth.username && currentAuth.password === startAuth.password) {
						const credentials = await resetCredentials();

						await ensureAuth(credentials.username, credentials.password);
					}

					process.kill();

					return await launchOpenVPN(t).then(resolve).catch(reject);
				} else if (l.includes("Initialization Sequence Completed")) {
					resolve(t);
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

	return new Promise<void>((resolve, reject) => {
		server.on("listening", () => {
			console.log(`Proxy up for ${t.configName} dev=${t.devName} port=${t.port} localAddress=${t.interfaceIp || "default"}`);
			resolve();
		});

		server.on("error", (e) => reject(e));
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

	const separator = "\r\n\r\n";
	const separatorIndex = firstChunk.indexOf(separator);

	if (separatorIndex === -1) {
		client.destroy(); // Incomplete headers
		return;
	}

	const headersPart = firstChunk.subarray(0, separatorIndex);
	const restOfChunk = firstChunk.subarray(separatorIndex + separator.length);
	const headers = headersPart.toString("utf8");
	const firstLine = headers.split("\r\n")[0] || "";

	if (/^CONNECT\s+/i.test(firstLine)) {
		const target = firstLine.split(/\s+/)[1];
		if (!target) {
			client.destroy();
			return;
		}
		// For CONNECT, we establish a tunnel. Any data after the headers is part of the tunnelled stream.
		handleConnect(target, client, restOfChunk, t, false);
	} else if (/^[A-Z]+\s+https?:\/\//.test(firstLine)) {
		const hostLine = headers.match(/Host:\s*([^\r\n]+)/i);
		const host = hostLine?.[1];
		const urlHost =
			host ||
			(() => {
				try {
					// The second part of the request line is the URL
					return new URL(firstLine.split(/\s+/)[1]).host;
				} catch {
					return undefined;
				}
			})();
		if (!urlHost) {
			client.destroy();
			return;
		}
		// For HTTP forwarding, the whole first chunk is the request.
		handleConnect(`${urlHost}:80`, client, firstChunk, t, true);
	} else {
		client.destroy();
	}
}

function handleConnect(target: string, client: net.Socket, initialData: Buffer, tunnel: TunnelInfo, isHttpForward = false) {
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
		console.log(`[proxy] ${tunnel.configName} forwarding to ${host}(${dstIp}):${port} from dev=${tunnel.devName}`);

		console.log(`[socket] using dialer dev=${tunnel.devName} -> ${dstIp}:${port}`);
		const remote = connectViaDialer(tunnel.devName, dstIp, port);

		const setupPipe = () => {
			client.pipe(remote).pipe(client);
		};

		remote.on("error", (err) => {
			console.warn(`[dialer-socket-error] ${err.message}`);
			client.destroy();
		});
		remote.on("close", () => client.destroy());
		client.on("close", () => remote.destroy());
		client.on("error", (err) => {
			console.warn(`[client-socket-error] ${err.message}`);
			remote.destroy();
		});

		if (isHttpForward) {
			remote.write(initialData, (err) => {
				if (err) {
					client.destroy();
					remote.destroy();
				} else {
					setupPipe();
				}
			});
		} else {
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n", (err) => {
				if (err) {
					client.destroy();
					remote.destroy();
					return;
				}
				if (initialData.length > 0) {
					remote.write(initialData, (err) => {
						if (err) {
							client.destroy();
							remote.destroy();
						} else {
							setupPipe();
						}
					});
				} else {
					setupPipe();
				}
			});
		}
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

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
	await ensureTun();

	const credentials = await resetCredentials.immediate();
	await sleep(1000 * 5); // wait for credentials to propagate

	await ensureAuth(credentials.username, credentials.password);
	await fs.mkdir(OPENVPN_BASE_LOG_DIR, { recursive: true });
	await overrideDNS();

	const configs = await listConfigs();
	const tunnels = await assignPorts(configs);
	console.log(`Launching ${tunnels.length} openvpn tunnels`);

	console.log(`Starting rotating proxy on port ${BASE_PORT}`);

	createRotatingProxy(BASE_PORT, tunnels);

	const promises = tunnels.map((x) => launchOpenVPN(x).then((x) => createTcpProxy(x)));

	await Promise.allSettled(promises);

	console.log(`All Tunnels are up and running`);

	console.log(`Service is ready. Connect your applications to the rotating proxy on port ${BASE_PORT}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
