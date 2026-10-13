// What the live and take scripts print of a server log when a take fails: a run link's fragment is the run's secret, and a Bearer token is one too.
// The link is matched by its shape (/run/<anything up to the #>#<anything up to the end of the token>), never by the characters a run id may have: a dotted id (walks-home.rehearsal) once slipped past a [A-Za-z0-9_-] pattern.
export const redact = (text: string): string => text.replace(/(\/run\/[^\s#"'<>]+)#[^\s"'<>]+/g, "$1#<redacted>").replace(/Bearer\s+\S+/g, "Bearer <redacted>");
