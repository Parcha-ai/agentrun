import type { Plugin } from "vite";
export const RUNTIME_DEPENDENCIES: Set<string>;
export function assertConsoleDependencies(manifest: { dependencies?: Record<string, string> }): void;
export function assertBundledPackage(name: string): void;
export function assertBrowserText(text: string, name: string): void;
export function packageRoot(id: string): string | null;
export function consoleBoundary(): Plugin;
