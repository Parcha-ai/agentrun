// The sign-in page: posts the email and password as JSON to the library's /v2/auth/sign-in/email, then opens the page.
const form = document.getElementById("sign-in");
const said = document.getElementById("said");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  said.className = "said";
  said.textContent = "Signing in…";
  const body = { email: form.elements.email.value, password: form.elements.password.value };
  try {
    const res = await fetch("/v2/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
    if (res.ok) return location.assign(location.pathname === "/sign-in" ? "/" : location.href);
    said.className = "said wrong";
    said.textContent = res.status === 429 ? "Too many tries: wait a little, then try again." : "That email and password do not sign anyone in.";
  } catch {
    said.className = "said wrong";
    said.textContent = "The server did not answer.";
  }
});
