// The agent's computer, with the run's home/ read through. In the tab, home/ (the model's files, the trained policies, skills.json) is not copied into the computer's workspace: the page reads it from the run's disk (the creature page and the offline
// cache do). The robot tools read home/skills.json and the skills' policy files through the computer, so on a run that has come home to the tab they saw "no skill has come home yet" while the page was playing the skill. This wraps the
// computer's `readTextFile`: a file under home/ that the computer does not have is read from the disk instead. Everything else is the computer's own. Portable: no Node API.

interface TextReader { readTextFile(path: string, context: never): Promise<{ ok: true; value: string } | { ok: false; error: { code: string; message: string } }> }

const isHome = (path: string) => /^(\.\/)?home\//.test(path);

export function withHomeFallback<E extends TextReader>(env: E, read: (path: string) => Promise<Uint8Array | null>): E {
  return new Proxy(env, {
    get(target, key) {
      if (key === "readTextFile") {
        return async (path: string, context: never) => {
          const own = await target.readTextFile(path, context);
          if (own.ok || own.error.code !== "not_found" || !isHome(path)) return own;
          const bytes = await read(path.replace(/^\.\//, "")).catch(() => null);
          return bytes ? { ok: true as const, value: new TextDecoder().decode(bytes) } : own;
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
