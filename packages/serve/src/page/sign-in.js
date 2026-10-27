// The sign-in page: posts the email to /v2/auth/request-link and says where the link went. A sign-in link opens this page
// with its token in the fragment, which no server sees; the token is spent only when the person presses Continue, so a
// mail scanner that fetches the link signs nobody in.
const form = document.getElementById("sign-in");
const said = document.getElementById("said");
const link = new URLSearchParams(location.hash.slice(1));
const token = link.get("token");
if (token) {
  history.replaceState(null, "", location.pathname);
  form.hidden = true;
  const cont = document.getElementById("continue");
  const as = document.getElementById("continue-as");
  const continued = document.getElementById("continued");
  if (link.get("email")) as.textContent = `Continue as ${link.get("email")}`;
  cont.hidden = false;
  cont.addEventListener("submit", async (event) => {
    event.preventDefault();
    as.disabled = true;
    continued.className = "said";
    continued.textContent = "Signing in…";
    try {
      const res = await fetch("/v2/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ token }) });
      if (res.ok) return location.assign("/");
      cont.hidden = true;
      form.hidden = false;
      said.className = "said wrong";
      said.textContent = "That link did not sign you in: it was used already, or more than 15 minutes old. Ask for a new one.";
    } catch {
      as.disabled = false;
      continued.className = "said wrong";
      continued.textContent = "The server did not answer.";
    }
  });
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  said.className = "said";
  said.textContent = "Asking for a link…";
  try {
    const res = await fetch("/v2/auth/request-link", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ email: form.elements.email.value }) });
    const answer = await res.json().catch(() => null);
    if (res.ok) {
      said.textContent = "Check your email, or the server's log, for your sign-in link.";
      return;
    }
    said.className = "said wrong";
    said.textContent = answer?.error?.fields?.[0]?.message ?? answer?.error?.message ?? `The server answered ${res.status}.`;
  } catch {
    said.className = "said wrong";
    said.textContent = "The server did not answer.";
  }
});
