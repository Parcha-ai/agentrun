// The sign-in page: posts the email to /v2/auth/request-link and says where the link went. A link that did not sign in
// comes back here with #link=invalid.
const form = document.getElementById("sign-in");
const said = document.getElementById("said");
if (new URLSearchParams(location.hash.slice(1)).get("link") === "invalid") {
  said.className = "said wrong";
  said.textContent = "That link did not sign you in: it was used already, or more than 15 minutes old. Ask for a new one.";
  history.replaceState(null, "", location.pathname);
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
