// The setup page: posts the owner's form as JSON to /v2/setup, whose answer signs the owner in, and opens the page. A
// server with no public address takes no code; one that asks for it gets it from the link's fragment (never sent to the
// server in the address), or the person types it once the server says it needs one.
const form = document.getElementById("setup");
const said = document.getElementById("said");
const code = new URLSearchParams(location.hash.slice(1)).get("code");
const codeField = document.getElementById("code-field");
codeField.hidden = !code;
if (code) {
  form.elements.code.value = code;
  history.replaceState(null, "", location.pathname);
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  said.className = "said";
  said.textContent = "Making the owner…";
  const body = Object.fromEntries(["name", "email", ...(codeField.hidden ? [] : ["code"])].map((name) => [name, form.elements[name].value]));
  try {
    const res = await fetch("/v2/setup", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
    if (res.ok) return location.assign("/");
    const answer = await res.json().catch(() => null);
    if (res.status === 403 && codeField.hidden && /setup code/.test(answer?.error?.message ?? "")) codeField.hidden = false;
    said.className = "said wrong";
    said.textContent = answer?.error?.fields?.[0]?.message ?? answer?.error?.message ?? `The server answered ${res.status}.`;
  } catch {
    said.className = "said wrong";
    said.textContent = "The server did not answer.";
  }
});
