// The account pages' script and the page's Sign out button. Setup sets the password (with the code from the link's
// fragment when the server asks for one, which never reaches the server in the address); sign-in posts it; Sign out
// everywhere ends every session this server made.
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
const tell = (said, text, wrong = false) => {
  said.className = wrong ? "said wrong" : "said";
  said.textContent = text;
};
const problem = (answer, status) => answer?.error?.fields?.[0]?.message ?? answer?.error?.message ?? `The server answered ${status}.`;

const setup = document.getElementById("setup");
if (setup) {
  const said = document.getElementById("said");
  const codeField = document.getElementById("code-field");
  const code = new URLSearchParams(location.hash.slice(1)).get("code");
  codeField.hidden = !code;
  if (code) {
    setup.elements.code.value = code;
    history.replaceState(null, "", location.pathname);
  }
  setup.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (setup.elements.password.value !== setup.elements.again.value) return tell(said, "The two passwords differ.", true);
    tell(said, "Setting it…");
    try {
      const res = await post("/v2/setup", { password: setup.elements.password.value, ...(codeField.hidden ? {} : { code: setup.elements.code.value }) });
      if (res.ok) return location.assign("/");
      const answer = await res.json().catch(() => null);
      if (res.status === 403 && codeField.hidden && /setup code/.test(answer?.error?.message ?? "")) codeField.hidden = false;
      tell(said, problem(answer, res.status), true);
    } catch {
      tell(said, "The server did not answer.", true);
    }
  });
}

const signIn = document.getElementById("sign-in");
if (signIn) {
  const said = document.getElementById("said");
  signIn.addEventListener("submit", async (event) => {
    event.preventDefault();
    tell(said, "Signing in…");
    try {
      const res = await post("/v2/auth/sign-in", { password: signIn.elements.password.value });
      if (res.ok) return location.assign("/");
      tell(said, res.status === 401 ? "That is not the password." : problem(await res.json().catch(() => null), res.status), true);
    } catch {
      tell(said, "The server did not answer.", true);
    }
  });
}

const signOut = document.getElementById("sign-out");
if (signOut) {
  fetch("/v2/auth/session", { credentials: "same-origin" })
    .then((res) => (res.ok ? res.json() : null))
    .then((session) => void (signOut.hidden = !session?.signed_in))
    .catch(() => undefined);
  signOut.addEventListener("click", async () => {
    const res = await post("/v2/auth/sign-out", {}).catch(() => null);
    if (res?.ok) location.assign("/sign-in");
  });
}
