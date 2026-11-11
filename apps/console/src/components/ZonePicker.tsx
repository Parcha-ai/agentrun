import { Input } from "@/components/ui/field";
import { Picker } from "@/components/ui/picker";

// Every IANA zone this browser knows (Intl.supportedValuesOf), with UTC, which some browsers leave out of the list.
const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
const KNOWN: string[] = typeof supported === "function" ? supported("timeZone") : [];
const ZONES = KNOWN.length && !KNOWN.includes("UTC") ? ["UTC", ...KNOWN] : KNOWN;

/** A time zone, picked from the IANA zones this browser knows ("Europe/Madrid"). A zone it doesn't list (an older one
 *  read with a schedule) stays one of the choices. A browser that lists none gets a text field. Where it starts (the
 *  browser's own zone, browserZone) is the caller's. The Triggers form's schedule and a template's timezone parameter
 *  (its served `format: timezone`) both use it. */
export function ZonePicker({ value, onChange, label, name, id, className }: { value: string; onChange: (zone: string) => void; label: string; name?: string; id?: string; className?: string }) {
  if (!ZONES.length) return <Input id={id} name={name} aria-label={label} className={className} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Europe/Madrid" />;
  const zones = value && !ZONES.includes(value) ? [value, ...ZONES] : ZONES;
  return <Picker id={id} name={name} label={label} className={className} value={value} onChange={onChange} placeholder="Pick a time zone" options={zones.map((z) => ({ value: z, label: z.replace(/_/g, " ") }))} />;
}
