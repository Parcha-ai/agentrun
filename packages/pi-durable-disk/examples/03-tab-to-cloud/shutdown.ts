// Stopping the demo server: the cloud host's machines cost while they exist, so they are removed even when closing the server
// throws. Returns the process's exit code (1 when anything failed); never throws.
export async function closeServerAndCloud(
  server: { close(): Promise<void> },
  cloud: { close?(): Promise<void> } | undefined,
  log: (event: string, data?: Record<string, unknown>) => void,
): Promise<number> {
  let code = 0;
  try {
    await server.close();
  } catch (error) {
    log("close.failed", { error: (error as Error).message });
    code = 1;
  } finally {
    try {
      await cloud?.close?.();
    } catch (error) {
      log("cloud.close-failed", { error: (error as Error).message });
      code = 1;
    }
  }
  return code;
}
