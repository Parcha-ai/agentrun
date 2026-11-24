// The environment a docker CLI child is started with: the names docker reads, and nothing else of the caller's.

/**
 * The names the docker CLI (and what it starts: buildx, ssh, a credential helper) reads from its environment. Each is
 * where something is, or a setting, never a secret's value:
 * - the daemon: DOCKER_HOST, DOCKER_CONTEXT, the TLS files, the API version; SSH_AUTH_SOCK for an ssh:// host;
 *   XDG_RUNTIME_DIR for a rootless one; the proxy a TCP daemon is reached through;
 * - its config: DOCKER_CONFIG, else HOME's .docker (config.json, contexts, cli-plugins, buildx), BUILDX_*;
 * - a pull's credentials: the CLI runs the credential helper config.json names (docker-credential-<name>, found on
 *   PATH) with its own environment, so the places those helpers read are kept (the Secret Service's bus, pass's
 *   store and GnuPG home, a cloud profile, region, config or credential file), and never a key itself
 *   (AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, an Azure client secret), which a helper reads from a file instead;
 * - processes and temp files: PATH, TMPDIR, and Windows' and macOS's own.
 */
export const DOCKER_ENV_NAMES: readonly string[] = [
	"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL",
	"DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_API_VERSION",
	"DOCKER_DEFAULT_PLATFORM", "DOCKER_BUILDKIT", "BUILDX_CONFIG", "BUILDX_BUILDER",
	"SSH_AUTH_SOCK", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
	"DBUS_SESSION_BUS_ADDRESS", "PASSWORD_STORE_DIR", "GNUPGHOME", "GPG_AGENT_INFO",
	"AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_ROLE_ARN",
	"AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_SDK_LOAD_CONFIG",
	"GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG",
	"SystemRoot", "SYSTEMROOT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "PATHEXT", "COMSPEC", "TEMP", "TMP",
];

/**
 * The environment for a docker CLI child: `env`'s values of the names docker reads (DOCKER_ENV_NAMES) alone. Anything
 * else, a key the caller holds included, never reaches docker or what it starts.
 */
export function dockerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const name of DOCKER_ENV_NAMES) {
		const value = env[name];
		if (value !== undefined) out[name] = value;
	}
	return out;
}
