// Whether a program this server runs on its own machine is there: a provider's (the phone's adb, computers.ts) and the
// screen recorder's ffmpeg (computer-record.ts).
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Whether a folder of `path` (a PATH value) holds an executable file named `command`; on Windows, with an executable
 *  extension too (platform-tools installs adb.exe). */
export function commandOnPath(command: string, path: string | undefined, platform: string = process.platform): boolean {
  const named = platform === "win32" ? [command, ...[".exe", ".cmd", ".bat"].map((extension) => `${command}${extension}`)] : [command];
  return (path ?? "").split(delimiter).some((folder) =>
    folder !== "" && named.some((file) => {
      try {
        accessSync(join(folder, file), constants.X_OK);
        return statSync(join(folder, file)).isFile();
      } catch {
        return false;
      }
    }));
}
