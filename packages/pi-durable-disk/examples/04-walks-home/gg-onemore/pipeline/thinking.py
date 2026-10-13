# The edited model's thinking budget: one number in data/thinking.json, read here for the strength probes and by the page's
# provider (chat/gg-extra.ts), so what the probes grade is what the page serves.
import json
import os

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "thinking.json")) as f:
    THINK_BUDGET = int(json.load(f)["thinking_token_budget"])
