// With accounts, an admin's card on the page: add a teammate by email. Without a mail server the answer carries their
// one-time sign-in link, shown here with a Copy button for the admin to pass on; with one, the link is mailed.
(async () => {
  const me = await fetch("/v2/me", { credentials: "same-origin" }).then((res) => (res.ok ? res.json() : null), () => null);
  if (!me || me.role !== "admin" || me.kind !== "person") return;
  const card = document.createElement("section");
  card.className = "card people";
  card.innerHTML = `<h2>Add a teammate</h2>
<form id="add-person" novalidate>
<label class="field"><span class="word">Email</span><input type="email" name="email" autocomplete="off" required></label>
<label class="field"><span class="word">Name</span><input type="text" name="name" maxlength="100"></label>
<label class="field"><span class="word">Role</span><select name="role"><option value="member">member</option><option value="admin">admin</option></select></label>
<div class="actions"><button class="btn" type="submit">Add</button></div>
</form>
<p class="said" id="added" role="status"></p>
<div class="link" id="added-link" hidden><input type="text" readonly id="link-text" aria-label="Their sign-in link"><button class="btn" type="button" id="copy-link">Copy</button></div>`;
  document.querySelector("footer.foot").before(card);
  const form = card.querySelector("#add-person");
  const said = card.querySelector("#added");
  const box = card.querySelector("#added-link");
  const text = card.querySelector("#link-text");
  card.querySelector("#copy-link").addEventListener("click", async () => {
    text.select();
    await navigator.clipboard?.writeText(text.value).catch(() => undefined);
    said.textContent = "Copied. Send it to them: it works once, within 15 minutes.";
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    box.hidden = true;
    said.className = "said";
    said.textContent = "Adding…";
    const body = { email: form.elements.email.value, role: form.elements.role.value, ...(form.elements.name.value.trim() ? { name: form.elements.name.value } : {}) };
    try {
      const res = await fetch("/v2/people", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
      const answer = await res.json().catch(() => null);
      if (!res.ok) {
        said.className = "said wrong";
        said.textContent = answer?.error?.fields?.[0]?.message ?? answer?.error?.message ?? `The server answered ${res.status}.`;
        return;
      }
      form.reset();
      if (answer.sign_in_link) {
        text.value = answer.sign_in_link;
        box.hidden = false;
        said.textContent = `${answer.email} is added. This server sends no mail: copy their sign-in link and send it to them.`;
      } else {
        said.textContent = `${answer.email} is added, and their sign-in link is in their email.`;
      }
    } catch {
      said.className = "said wrong";
      said.textContent = "The server did not answer.";
    }
  });
})();
