# The reading list, fetched at box start: Anthropic's Golden Gate Claude work and the open Qwen replication, as text.
import html
import json
import re
import sys
import urllib.request

out = sys.argv[1]
PAGES = {
    "anthropic-scaling-monosemanticity.txt": "https://transformer-circuits.pub/2024/scaling-monosemanticity/index.html",
    "anthropic-golden-gate-claude.txt": "https://www.anthropic.com/news/golden-gate-claude",
    "golden-gate-qwen-README.txt": "https://huggingface.co/discodamone/golden-gate-qwen/raw/main/README.md",
    "golden-gate-qwen-steering_config.json": "https://huggingface.co/discodamone/golden-gate-qwen/raw/main/steering_config.json",
    "qwen-scope-sae-README.txt": "https://huggingface.co/Qwen/SAE-Res-Qwen3.5-27B-W80K-L0_50/raw/main/README.md",
}


def text(raw):
    raw = re.sub(r"(?is)<(script|style|svg|noscript)[^>]*>.*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<br\s*/?>|</(p|div|h\d|li|tr|section)>", "\n", raw)
    raw = re.sub(r"<[^>]+>", " ", raw)
    raw = html.unescape(raw)
    raw = re.sub(r"[ \t]+", " ", raw)
    return re.sub(r"\n\s*\n+", "\n\n", raw).strip()


for name, url in PAGES.items():
    try:
        req = urllib.request.Request(url, headers={"user-agent": "Mozilla/5.0 (gg-onemore reading list)"})
        raw = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
        body = raw if name.endswith((".json", "README.txt")) else text(raw)
        open(f"{out}/{name}", "w").write(f"Source: {url}\n\n{body}\n")
        print(json.dumps({"fetched": name, "chars": len(body)}), flush=True)
    except Exception as e:
        print(json.dumps({"failed": name, "error": str(e)[:200]}), flush=True)
