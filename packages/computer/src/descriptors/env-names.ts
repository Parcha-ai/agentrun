// The names of the host's environment a child this package starts is handed (child-env.ts childEnv): every child's,
// the docker CLI's and Chrome's. Here, beside the descriptors, so a descriptor's hostEnv names them and loads no provider
// code; this file imports nothing.
//
// No list names a variable serve's keyShaped() takes for a key's (a segment KEY, TOKEN, SECRET, PASS, CREDENTIAL(S) ...),
// a pointer to a credential's file included: serve's child-env-names test holds that for every list here.

/** The variables every child reads: where programs and the home and temp directories are, the locale, and Windows' and
 *  macOS's own. */
export const BASE_ENV_NAMES: readonly string[] = Object.freeze([
	"PATH", "HOME", "TMPDIR", "TZ",
	"LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_COLLATE", "LC_MESSAGES", "LC_NUMERIC", "LC_TIME", "LC_MONETARY", "LC_PAPER",
	"LC_NAME", "LC_ADDRESS", "LC_TELEPHONE", "LC_MEASUREMENT", "LC_IDENTIFICATION",
	"SystemRoot", "SYSTEMROOT", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "PATHEXT", "COMSPEC", "TEMP", "TMP",
]);

/**
 * The docker CLI's, beside the base (and what it starts: buildx, ssh, a credential helper, which inherit its environment):
 * - the daemon: DOCKER_HOST, DOCKER_CONTEXT, the TLS files, the API version; SSH_AUTH_SOCK for an ssh:// host;
 *   XDG_RUNTIME_DIR for a rootless one; the proxy a TCP daemon or a registry is reached through, in both cases;
 * - its config: DOCKER_CONFIG, else HOME's .docker (config.json, contexts, cli-plugins, buildx), BUILDX_*;
 * - a pull's credentials: the credential helper config.json names (docker-credential-<name>, on PATH) finds them where
 *   these say: the Secret Service's bus, GnuPG's home and agent, a cloud CLI's profile, region and config. Never a key
 *   (AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AZURE_CLIENT_SECRET, DOCKER_CUSTOM_HEADERS, a content trust passphrase),
 *   nor a name shaped as one (AWS_SHARED_CREDENTIALS_FILE, AWS_WEB_IDENTITY_TOKEN_FILE,
 *   AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, GOOGLE_APPLICATION_CREDENTIALS, PASSWORD_STORE_DIR): a helper that needs
 *   one reads it from its default place, a profile or a role instead.
 */
export const DOCKER_ENV_NAMES: readonly string[] = Object.freeze([
	...BASE_ENV_NAMES,
	"DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_API_VERSION",
	"DOCKER_DEFAULT_PLATFORM", "DOCKER_BUILDKIT", "BUILDX_CONFIG", "BUILDX_BUILDER",
	"SSH_AUTH_SOCK", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
	"DBUS_SESSION_BUS_ADDRESS", "GNUPGHOME", "GPG_AGENT_INFO",
	"AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_CONFIG_FILE", "AWS_SDK_LOAD_CONFIG",
	"CLOUDSDK_CONFIG",
]);

/**
 * Chrome's, beside the base, for the local browser's supervisor and the Chrome it starts and the sandbox check's Chrome:
 * the display it may draw on (X's or Wayland's, and X's authority file), the XDG directories it keeps its config, cache
 * and fonts' cache in, fontconfig's files, the session bus, and the setuid sandbox's path where a host names one. No
 * proxy: Chrome is always given its own (--proxy-server), the fence. Nothing else it may read (GOOGLE_API_KEY and the
 * like, Google's services' keys) reaches it.
 */
export const CHROME_ENV_NAMES: readonly string[] = Object.freeze([
	...BASE_ENV_NAMES,
	"DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY",
	"XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_DATA_DIRS", "XDG_CONFIG_DIRS",
	"FONTCONFIG_FILE", "FONTCONFIG_PATH", "FONTCONFIG_SYSROOT",
	"DBUS_SESSION_BUS_ADDRESS", "CHROME_DEVEL_SANDBOX",
]);
