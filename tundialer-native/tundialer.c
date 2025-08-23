#define _GNU_SOURCE
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <net/if.h>
#include <netinet/tcp.h>
#include <node_api.h>

static napi_value Connect(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3];
    napi_status status;

    status = napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    if (status != napi_ok) {
        napi_throw_error(env, NULL, "Failed to parse arguments");
        return NULL;
    }

    if (argc < 3) {
        napi_throw_error(env, NULL, "Usage: connect(iface, ip, port)");
        return NULL;
    }

    // Arg 0: iface (string)
    char iface[IFNAMSIZ];
    size_t iface_len;
    status = napi_get_value_string_utf8(env, args[0], iface, sizeof(iface), &iface_len);
    if (status != napi_ok) {
        napi_throw_error(env, NULL, "Invalid iface argument");
        return NULL;
    }

    // Arg 1: ip (string)
    char ip[INET_ADDRSTRLEN];
    size_t ip_len;
    status = napi_get_value_string_utf8(env, args[1], ip, sizeof(ip), &ip_len);
    if (status != napi_ok) {
        napi_throw_error(env, NULL, "Invalid ip argument");
        return NULL;
    }

    // Arg 2: port (number)
    int32_t port;
    status = napi_get_value_int32(env, args[2], &port);
    if (status != napi_ok) {
        napi_throw_error(env, NULL, "Invalid port argument");
        return NULL;
    }

    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) {
        napi_throw_error(env, "errno", "socket() failed");
        return NULL;
    }

    if (setsockopt(s, SOL_SOCKET, SO_BINDTODEVICE, iface, strlen(iface)) < 0) {
        close(s);
        napi_throw_error(env, "errno", "setsockopt(SO_BINDTODEVICE) failed");
        return NULL;
    }

    int one = 1;
    setsockopt(s, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

    struct sockaddr_in a;
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_port = htons(port);
    if (inet_pton(AF_INET, ip, &a.sin_addr) != 1) {
        close(s);
        napi_throw_error(env, NULL, "inet_pton() failed: invalid IP address");
        return NULL;
    }

    if (connect(s, (struct sockaddr*)&a, sizeof(a)) < 0) {
        close(s);
        napi_throw_error(env, "errno", "connect() failed");
        return NULL;
    }

    napi_value result;
    status = napi_create_int32(env, s, &result);
    if (status != napi_ok) {
        close(s);
        napi_throw_error(env, NULL, "Failed to create return value");
        return NULL;
    }

    return result;
}

napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor desc = { "connect", NULL, Connect, NULL, NULL, NULL, napi_default, NULL };
  napi_define_properties(env, exports, 1, &desc);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
