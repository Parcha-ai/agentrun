// A stand-in for the real page: it names the agent from /api/agent.
fetch("/api/agent").then((response) => response.json()).then((agent) => {
  document.getElementById("app").textContent = `${agent.definition.name}: ${agent.counts.runs} runs`;
}).catch((error) => {
  document.getElementById("app").textContent = String(error);
});
