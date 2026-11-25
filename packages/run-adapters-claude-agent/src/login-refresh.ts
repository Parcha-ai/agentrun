// How the pinned CLI renews a person's login, for a host that holds the login itself and renews it in the CLI's place
// (serve's runner, whose runs under a user of their own get the access token alone: login.ts ClaudeLoginToken).
// Written for AgentRun.
//
// Read from the pinned CLI's bundled code (2.1.286, from Agent SDK 0.3.286: versions.ts), with no run of it. Each value
// below is cited by the code it is in; test/pins.test.mjs reads the installed CLI and turns red when a repin moves any
// of them (the token URL, the client id, the request's body or header, the answer's fields, the write back, the lock).
//
// - The request: the CLI's refresh (`grant_type:"refresh_token"`) posts
//   `{grant_type:"refresh_token",refresh_token:<the login's>,client_id:<the login's clientId>??CLIENT_ID,scope:<scopes>.join(" ")}`
//   as JSON to `cn().TOKEN_URL`, with `{headers:{"Content-Type":"application/json"},timeout:30000}`. Its scopes are the
//   login's own (`scopes:X.scopes`, what it sends when the login names its client, and its fallback), or the list below.
// - The answer: `{access_token, refresh_token = the one sent, expires_in}` (seconds), and `refresh_token_expires_in`
//   and `scope` when given. Any status but 200 is a failure; `invalid_grant` marks the refresh token dead.
// - The write back: `{...file, claudeAiOauth: {accessToken, refreshToken, expiresAt: now + expires_in * 1000,
//   refreshTokenExpiresAt: the answer's ?? the file's, scopes, subscriptionType, rateLimitTier, clientId}}`, only while
//   the file still holds the refresh token it sent (or a cleared one), through its atomic writer at mode 0600
//   (`await <write>(<path>,<json>,384),await <chmod>(<path>,384)`, 384 = 0o600).
// - The lock: before it reads the login to renew it, it takes a lock with proper-lockfile's options
//   `{lockfilePath:<credentials dir>/.oauth_refresh.lock,realpath:!1,stale:60000,update:5000}` (a directory made with
//   mkdir, its mtime touched every 5 s while held, taken over once 60 s old), then the older path
//   `<realpath of the credentials dir>.lock` with the same options; it reads the login again under them, and takes a
//   token another holder renewed meanwhile instead of renewing.

/** The pinned CLI's renewal of a login: where it posts, as which client, with which scopes when the login names none,
 *  and the lock it holds while it renews. */
export const LOGIN_REFRESH = Object.freeze({
  /** `TOKEN_URL:"https://platform.claude.com/v1/oauth/token"` in the CLI's production OAuth config (the one object that
   *  also holds its `CLIENT_ID`). */
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  /** `CLIENT_ID:"9d1c250a-e61b-44d9-88ed-5944d1962f5e"` in the same object: the CLI's public OAuth client, which it sends
   *  when the login names no `clientId` of its own (`client_id:s??cn().CLIENT_ID`). */
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  /** The scopes it asks for when the login holds none: its list
   *  `[user:profile, user:inference, "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"]`, and
   *  `user:plugins` (its production config's `PLUGINS_SCOPE_REGISTERED:!0`). */
  scopes: Object.freeze(["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload", "user:plugins"] as const),
  /** The lock's directory in the credentials directory: `lockfilePath:<join>(e,".oauth_refresh.lock")`. */
  lockName: ".oauth_refresh.lock",
  /** The older lock's suffix, on the credentials directory's real path: `` `${await <realpath>(e)}.lock` ``. */
  legacyLockSuffix: ".lock",
  /** A lock older than this is a dead holder's, taken over: `stale:60000`. */
  lockStaleMs: 60_000,
  /** How often a holder touches its lock: `update:5000`. */
  lockUpdateMs: 5_000,
});
