import { TraeCliError } from "./errors.ts";

export const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
export const SYSTEM_CA_BUNDLE = "/private/etc/ssl/cert.pem";
function path(value: string): string {
  if (!value.startsWith("/") || /["\\\x00-\x1f]/.test(value) || value.split("/").includes("..")) {
    throw new TraeCliError("configuration");
  }
  return JSON.stringify(value);
}
export function sandboxProfile(executable: string, root: string, port?: number, nativeAuthFile?: string, nativeModelsFile?: string): string {
  const exe = path(executable), data = path(root);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new TraeCliError("configuration");
  return [
    "(version 1)", "(deny default)", '(import "dyld-support.sb")',
    `(allow process-exec (literal ${exe}))`,
    "(allow file-read-metadata)",
    `(allow file-read* (subpath "/usr/lib") (literal ${exe}) (subpath ${data}))`,
    `(allow file-map-executable (literal ${exe}))`,
    `(allow file-read* (literal "${SYSTEM_CA_BUNDLE}"))`,
    `(deny file-write* (literal "${SYSTEM_CA_BUNDLE}"))`,
    `(allow file-write* (subpath ${data}))`,
    `(deny file-write* (literal ${exe}))`,
    ...(nativeAuthFile ? [`(allow file-read* (literal ${path(nativeAuthFile)}))`,
      `(deny file-write* (literal ${path(nativeAuthFile)}))`] : []),
    ...(nativeModelsFile ? [`(allow file-read* (literal ${path(nativeModelsFile)}))`,
      `(deny file-write* (literal ${path(nativeModelsFile)}))`] : []),
    '(allow file-read* file-write* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
    "(allow sysctl-read)",
    ...(port === undefined ? [] : [`(allow network-outbound (remote tcp "localhost:${port}"))`]),
  ].join("\n");
}
export function isolatedEnvironment(root: string, port?: number, token?: string): NodeJS.ProcessEnv {
  path(root);
  const env: NodeJS.ProcessEnv = {
    HOME: root + "/home", TMPDIR: root + "/tmp",
    TRAE_HOME: root + "/home/.trae", TRAECLI_HOME: root + "/home/.trae", CODEX_HOME: root + "/home/.trae",
    XDG_CONFIG_HOME: root + "/home/config", XDG_DATA_HOME: root + "/home/data",
    XDG_CACHE_HOME: root + "/home/cache", PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", NO_COLOR: "1", TERM: "dumb",
    OPENSSL_CONF: "/dev/null",
    SSL_CERT_FILE: SYSTEM_CA_BUNDLE,
    // Argos bypasses the generic OTel switches in CLI 0.210.1. Keep trace
    // bodies disabled and retain HTTPS admission for any native exporter.
    TRAECLI_TRACE_ENABLED: "false",
    TRAECLI_TRACE_LOG_BODY: "false",
    TRAECLI_METRICS_ENDPOINT: "https://argos-data-collector.bytedance.net/v1/metrics",
    TRAECLI_FILE_LOG_ENDPOINT: "https://argos-data-collector.bytedance.net/v1/logs",
  };
  if (port !== undefined) {
    if (!token || !/^[A-Za-z0-9_-]{1,128}$/.test(token)) throw new TraeCliError("configuration");
    const url = `http://keystone:${token}@127.0.0.1:${port}`;
    Object.assign(env, { HTTPS_PROXY: url, HTTP_PROXY: url, ALL_PROXY: url,
      https_proxy: url, http_proxy: url, all_proxy: url });
  }
  return env;
}
