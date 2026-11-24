# OSWorld-Verified pilot port

Twenty tasks from OSWorld-Verified, ported to run on our Linux desktop (the box image every desktop provider starts
from), all on the held-out split. A pass rate on this suite is a number for these 20 tasks under our checks, not an
OSWorld score: say "OSWorld-Verified port, 20 of 360 tasks, our checks".

## Source

- Repository: https://github.com/xlang-ai/OSWorld
- Revision: `0ad41bee56565efe7bb3c3a5ebc67590a1b8276f` (2026-11-23). Each task's `source.revision` names it.
- Task files: `evaluation_examples/examples/<domain>/<uuid>.json`; the scripts and documents they download come from
  OSWorld's file cache, the Hugging Face dataset `xlangai/ubuntu_osworld_file_cache`, at the same paths.
- OSWorld-Verified is `test_all.json`, 368 tasks; `test_nogdrive.json` drops the 8 Google Drive ones, leaving 360.
  Built for an Ubuntu 22.04 GNOME virtual machine with root, an accessibility tree, Chrome, LibreOffice, GIMP, VLC,
  Thunderbird and VS Code.

## Licence

OSWorld is Apache-2.0: `Copyright 2024 XLANG NLP Lab`, the `LICENSE` file at that revision; there is no NOTICE file.
Apache-2.0 lets us copy, change and redistribute in this Apache-2.0 repository, on two conditions: keep the licence
notice, and mark what we changed (§4(b)). So:

- Each task's `source.licence` repeats the notice, and `source.changes` says what the port changed.
- Each script copied from OSWorld (`setup.sh`, `eval.sh`, `eval.py`) opens with a header naming its origin, its licence
  and its changes.
- Three documents are OSWorld's own, copied byte for byte with no header, since one would change what the agent edits:
  `vscode-0ed39f63/vscode_replace_text.txt`, `vscode-0ed39f63/vscode_replace_text_gold.txt` and `vscode-ec71221e/test.py`.

OSWorld's README asks those who use it to cite it:

```
@misc{OSWorld,
      title={OSWorld: Benchmarking Multimodal Agents for Open-Ended Tasks in Real Computer Environments},
      author={Tianbao Xie and Danyang Zhang and Jixuan Chen and Xiaochuan Li and Siheng Zhao and Ruisheng Cao and Toh Jing Hua and Zhoujun Cheng and Dongchan Shin and Fangyu Lei and Yitao Liu and Yiheng Xu and Shuyan Zhou and Silvio Savarese and Caiming Xiong and Victor Zhong and Tao Yu},
      year={2024},
      eprint={2404.07972},
      archivePrefix={arXiv},
      primaryClass={cs.AI}
}
```

## What our desktop has, and what it lacks

Every desktop provider (E2B, Fly, Cloudflare, Modal, Docker) starts from the box image
(`packages/computer/box/install.sh`): Xfce's terminal, Mousepad, Firefox ESR, xdotool, python3 (sqlite3 in its
standard library), git, gzip, tar, diffutils and bsdutils' `script`. The bench drives it as an unprivileged user
whose HOME is /tmp. It lacks:

| OSWorld needs | we have | tasks out (of 360) |
| --- | --- | --- |
| LibreOffice Calc, Impress, Writer | nothing | 117, and most of multi_apps |
| GIMP, VLC, Thunderbird | nothing | 58, and some of multi_apps |
| Chrome (its Preferences, extensions, DevTools-read page state) | Firefox ESR | 39 of 45 |
| VS Code (its settings, extensions, workspaces) | Mousepad | 20 of 23 |
| GNOME: gsettings and dconf (dim screen, favourites, Do Not Disturb, wallpaper), the dock, Ctrl+Alt+T, Nautilus | Xfce's window manager and terminal, no panel, no file manager | most of the os tasks left out |
| root and sudo (`{CLIENT_PASSWORD}`: apt installs, users, system settings) | none | every such task |
| `gio`, `xsel`/`xclip`, `unzip`, `file` | none; a port works around them where it can | those it can't |
| the accessibility tree OSWorld can hand an agent | no `ui` group on a Linux desktop: screenshots and input only | none, but agents see less |
| live web pages | an egress allow-list; pages off the list don't load | tasks whose check reads a live page |

Two more differences matter for reading results:

- OSWorld's agent acts through the GUI (pyautogui). Here the task denies exec, so the agent has no shell or processes
  of its own, but it keeps the files group (read, write, move, list). A task whose end state is a file can be done
  without the GUI. The Mousepad new-file task checks the window's title for that reason, as linux-desktop's new-note
  does; the others accept the file however it got there.
- OSWorld pressed Ctrl+S for the agent before checking the VS Code tasks. Here the agent must save, and the instruction
  says so.

## Selection rule

A task was ported when all of these hold:

1. It needs only the terminal, Mousepad (for a VS Code text task) or Firefox (for a Chrome settings or bookmark task).
2. Its start state can be built from the task folder without root, and its evaluator can be rewritten as a check that
   reads files or runs a program through `exec.run`.
3. Its check does not depend on a live web page loading.
4. The port changes the task's meaning as little as a path or an app name.

Per domain, of the 360 without Google Drive: os 10 of 24, chrome 6 of 45, vs_code 3 of 23, multi_apps 1 of 93; none
of LibreOffice, GIMP, VLC or Thunderbird. Tried and dropped: os/13584542 (terminal size: xfce4-terminal keeps it in
xfconf, which this desktop may not run), the Chrome history and cookie tasks (they need history or cookies planted in a
database by hand for live sites), and the clipboard task (no xsel or xclip).

## Field mapping

| OSWorld (`<domain>/<uuid>.json`) | computer-bench (`task.json`) |
| --- | --- |
| domain and uuid | `source.id` (`os/5c1075ca-...`); the folder is `<domain>-<first 8 of the uuid>`, the id `osworld.<first 8>` |
| `instruction` | `instruction`: word for word, with `/home/user` (or `/tmp/test_files`) made the run's folder where the instruction names a path, Chrome made Firefox and VS Code made Mousepad where it names the app, and a "Save the file" sentence for the VS Code tasks |
| `config` (download, execute, launch, activate_window) | `setup`: `exec.run` steps that build the state in `/tmp/computer-bench-<nonce>`, the run's folder, which stands in for `/home/user`, then `process.start` of the app and an `exec.run` that places its window |
| `evaluator` (postconfig, func, result, expected) | `checks`: `exec` checks running OSWorld's eval script or our Python port of its getter and metric, `file` checks, and an `answer` check for the infeasible task |
| `func: infeasible` | `sufficient: false`, an `answer` check for the refusal, an `exec` check that nothing was faked, and `rubric.md` |
| none | `oracle` (the solved state, for `verify`), `teardown`, `budget` |

Each run's folder is HOME for the terminal it opens, so Trash, `~/.gitconfig` and `~/.local` are the run's own. Setup
opens the terminal itself, since this desktop has no dock or terminal shortcut; OSWorld's tasks mostly opened GNOME
Terminal with Ctrl+Alt+T too. Firefox runs on a fresh profile in the run's folder, with the first-run pages off
(linux-desktop's `user.js`).

## The tasks

| folder | OSWorld id | app | what it asks | check |
| --- | --- | --- | --- | --- |
| os-e0df059f | os/e0df059f-28a6-4169-924f-b9623e7184cc | terminal | rename a folder on the Desktop | OSWorld's test for the new name |
| os-23393935 | os/23393935-50c7-4a86-aeea-2b78fd089c5c | terminal | copy every .jpg under photos into one folder | the folder holds exactly the four .jpg files |
| os-5c1075ca | os/5c1075ca-bb34-46a3-a7a0-029bd7463e79 | terminal | copy *failed.ipynb into ./fails, keeping folders | OSWorld's eval.sh |
| os-5ced85fc | os/5ced85fc-fa1a-4217-95fd-0fb530545ce2 | terminal | append `<br/>` to 1, 2, 3 into output.txt | output.txt's text |
| os-37887e8c | os/37887e8c-da15-4192-923c-08fa390a176d | terminal | compress the files modified 30 days ago | OSWorld's eval in Python, two rules stricter |
| os-4127319a | os/4127319a-8b79-4410-b58a-7a151e15f3d7 | terminal | count the lines of every php file, shown in the terminal | OSWorld's line rule on the terminal's `script` log |
| os-4d117223 | os/4d117223-a354-47fb-8b45-62ab1390a95f | terminal | chmod 644 every regular file | OSWorld's eval.sh, and all three files kept |
| os-6f56bf42 | os/6f56bf42-85b8-4fbb-8e06-6c44960184ba | terminal | copy file1 into dir1, dir2, dir3 | OSWorld's eval.sh |
| os-5ea617a3 | os/5ea617a3-0e86-4ba6-aab2-dac9aa2e8d57 | terminal | restore a poster from the Trash | OSWorld's test, and the bytes match |
| os-c288e301 | os/c288e301-e626-4b98-a1ab-159dcb162af5 | terminal | make Python4 the default (infeasible) | refusal in the answer, no fake python4; graded with rubric.md |
| multi-2c9fc0de | multi_apps/2c9fc0de-3ee7-45e1-a5df-c86206ad78b5 | terminal, git | commit "daily update" and push to origin main | OSWorld's command, its two lines exactly |
| vscode-0ed39f63 | vs_code/0ed39f63-6049-43d4-ba4d-5fa2fe04a951 | Mousepad | replace "text" with "test" | the file equals OSWorld's gold copy |
| vscode-ec71221e | vs_code/ec71221e-ac43-46f9-89b8-ee7d80f7e1c5 | Mousepad | indent lines 2 to 10 by one tab | the original with a tab (or four spaces) before lines 2 to 10 |
| vscode-57242fad | vs_code/57242fad-77ca-454f-b71b-f187181a9f23 | Mousepad | create test.py and save it on the Desktop | the file exists, and Mousepad's window is titled test.py |
| chrome-bb5e4c0d | chrome/bb5e4c0d-f964-439c-97b6-bdb9747de3f4 | Firefox | make Bing the default search engine | the default engine in search.json.mozlz4 |
| chrome-af630914 | chrome/af630914-714e-4a24-a7bb-f9af687d3b91 | Firefox | default font size to the largest | font.size.variable.x-western above 16 |
| chrome-7a5a7856 | chrome/7a5a7856-f1b6-42a4-ade9-1ca81ca0f263 | Firefox | bookmark the page in view on the bookmarks bar | the toolbar's links in places.sqlite are exactly that page |
| chrome-3299584d | chrome/3299584d-8f11-4457-bf4c-ce98f7600250 | Firefox | stop opening funbrain.com at launch | startup page and homepage in prefs.js |
| chrome-99146c54 | chrome/99146c54-4f37-4ab8-9327-5f3291665e1e | Firefox | delete browsing data on every close | sanitizeOnShutdown (or never remember history) |
| chrome-9656a811 | chrome/9656a811-9b5b-4ddf-99c7-5117bcef0626 | Firefox | turn the harmful-site warning back on | malware and phishing protection both on |

Every check fails the state setup leaves: proven at $0 for the terminal and Mousepad tasks by running their setup's
shell steps, the checks, the oracle's commands and the checks again on a Linux machine (no X), and for the Firefox
checks on hand-made profiles (prefs.js, places.sqlite with its log, a mozlz4 file).

## Verify live

The fake backend is a fake Mac, so `verify` can't run these tasks at $0; `test/task.test.mjs` loads the suite and
holds its rules. On a live desktop, `verify` (null and oracle, no model) decides each task, and `run --verified` runs
only the task and seed pairs it proved right. Written without a live desktop, so verify decides:

- The five Firefox settings oracles (bb5e4c0d, af630914, 3299584d, 99146c54, 9656a811): about:preferences, Ctrl+F to
  its search, then a number of Tabs to reach the control. The Tab counts are read from Firefox's settings layout, not
  tried.
- chrome-7a5a7856: Ctrl+9 selecting the last of two command-line tabs, and Ctrl+D's panel filing the bookmark on the
  toolbar under `browser.bookmarks.defaultLocation`.
- vscode-ec71221e: Mousepad indenting a selection of lines on Tab.
- os-4127319a: xfce4-terminal running its shell under `script -q -f`.
- Every terminal task: xfce4-terminal started with HOME set to the run's folder (linux-desktop starts it with HOME as
  it is).

A task verify can't prove right drops out of the run, so the pilot may score fewer than 20.

## Running the pilot

Arms: `arms.json` here, Sonnet 5.5 and GPT-6.1 Terra on pi with the code surface, through OpenRouter, both at thinking
`medium` (`effort`; Sonnet 5.5 on OpenRouter answers 400 "Reasoning is mandatory" without it), on E2B desktops. The
model names are the ones serve lists for pi when OPENROUTER_API_KEY is its model key; check `GET /v2/capabilities`
before the run and fix a name there, not the arm's id.

The provider is E2B: linux-desktop verified 30 of 30 on it and the 11-14 Sonnet against Terra run went through it, and
serve reaches an E2B desktop over E2B's exec, so a serve on the same host as the bench works with no public URL. Fly, Cloudflare and
Modal desktops dial back to the server, which needs a public URL.

Environment, by name only:

- serve: `OPENROUTER_API_KEY`, `E2B_API_KEY`,
  `AGENTRUN_TELEMETRY=0`. Pages from jalammar.github.io, blog.eleuther.ai and funbrain.com load only if serve's egress
  allow-list (`AGENTRUN_BOX_ALLOW`) lets them; no check needs them to.
- computer-bench: `AGENTRUN_TOKEN` (serve's token), and `OPENROUTER_API_KEY` for the judge.

```
B=packages/computer-bench; S=$B/suites/osworld-pilot; API=$AGENTRUN_URL/v2   # serve's base URL
node $B/dist/cli.js validate $S
node $B/dist/cli.js verify --suite $S --arms $S/arms.json --backend serve --serve $API --out $OUT/verify --seeds 1,2,3 --parallel 4
node $B/dist/cli.js run --suite $S --arms $S/arms.json --backend serve --serve $API --verified $OUT/verify/verify.json \
  --out $OUT/run --seeds 1,2,3 --parallel 4 --retries 2 --grade auto --judge openrouter:anthropic/claude-opus-5.5
node $B/dist/cli.js report $OUT/run --split heldout
```

Budget per task: 100 computer steps (OSWorld's longest setting), $3 of model, 900 s. Cost, from the 11-14 E2B run of
linux-desktop (Sonnet about $0.04 an episode, at most $0.19 for 28 steps; Terra about $0.016; E2B under $2 for about
120 desktops of 1 to 2 minutes) scaled for OSWorld tasks being several times longer: Sonnet $0.10 to $0.30 an
episode, Terra $0.03 to $0.08. Three seeds, two arms, 20 tasks: 120 episodes, about $8 to $23 of model; $3 to $6 of judge
(`--grade auto` grades the infeasible task and every failed episode, say 60 at $0.05 to $0.10 each); and about $3 to
$6 of E2B for the 60 verify desktops and 120 run desktops: $14 to $35 in all. The per-episode cap bounds the worst case at $360 of model.
