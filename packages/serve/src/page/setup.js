// The setup page: takes the code from the link's fragment (never sent to the server in the address), then posts the
// owner's form as JSON to /v2/setup, whose answer signs the owner in, and opens the page.
const form = document.getElementById("setup");
const said = document.getElementById("said");
const code = new URLSearchParams(location.hash.slice(1)).get("code");
if (code) {
  form.elements.code.value = code;
  history.replaceState(null, "", location.pathname);
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  said.className = "said";
  said.textContent = "Making the owner…";
  const body = Object.fromEntries(["code", "name", "email"].map((name) => [name, form.elements[name].value]));
  try {
    const res = await fetch("/v2/setup", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
    if (res.ok) return location.assign("/");
    const answer = await res.json().catch(() => null);
    said.className = "said wrong";
    said.textContent = answer?.error?.fields?.[0]?.message ?? answer?.error?.message ?? `The server answered ${res.status}.`;
  } catch {
    said.className = "said wrong";
    said.textContent = "The server did not answer.";
  }
});
