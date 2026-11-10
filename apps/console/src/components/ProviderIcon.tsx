import { KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";

/** A provider's mark, bundled with the console (the page's policy loads no image from another site, and a key's page
 *  should tell no third party which providers a server lists). Each is one 24 by 24 path, drawn in the text's colour
 *  so it follows the theme. The paths are from Simple Icons (simpleicons.org, CC0 1.0); the marks stay their owners'.
 *  A provider with no mark here keeps the key. To add one: its id as the server names it (key-words.ts, model.ts) and
 *  a single-path 24 by 24 mark its owner lets you use. */
const MARKS: Record<string, string> = {
  anthropic: "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
  openrouter: "M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z",
};

export function ProviderIcon({ id, className }: { id: string; className?: string }) {
  const mark = MARKS[id];
  if (!mark) return <KeyRound className={cn("size-4 shrink-0 text-muted-foreground", className)} aria-hidden />;
  return <svg data-provider-mark={id} viewBox="0 0 24 24" fill="currentColor" className={cn("size-4 shrink-0", className)} aria-hidden><path d={mark} /></svg>;
}
