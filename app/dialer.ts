import net from "net";
import path from "path";
// @ts-ignore
import tundialer from "../tundialer-native/index.ts";

// eslint-disable-next-line @typescript-eslint/no-var-requires
// @ts-ignore

/**
 * Connects to a destination using the native tundialer module,
 * binding the connection to a specific network device.
 * @param dev The network device (e.g., "tun0").
 * @param dstIp The destination IP address.
 * @param port The destination port.
 * @returns A net.Socket instance for the established connection.
 */
export function connectViaDialer(dev: string, dstIp: string, port: number): net.Socket {
	const fd = tundialer.connect(dev, dstIp, port);
	if (fd < 0) {
		throw new Error("Failed to connect via tundialer");
	}
	return new net.Socket({ fd });
}
