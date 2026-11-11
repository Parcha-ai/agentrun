import { Input } from "@/components/ui/field";
import { cronWords } from "@/lib/schedules";

/** The zones this browser knows, for the zone input's list; none where it cannot list them (the input then takes any name). */
const ZONES: string[] = typeof (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf === "function" ? (Intl as unknown as { supportedValuesOf: (key: string) => string[] }).supportedValuesOf("timeZone") : [];
const ZONE_LIST = "schedule-zones";

/** The cron line input of a schedule, with the line in words under it once there is one ("0 8 * * 1" reads "At 08:00, only on
 *  Monday"). The Triggers page's schedule form and a template's Apply form take their schedule through this one input. */
export function CronLine({ name, value, onChange, placeholder, required }: { name: string; value: string; onChange: (value: string) => void; placeholder?: string; required?: boolean }) {
  return (
    <>
      <Input name={name} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} required={required} />
      {value.trim() !== "" && <span className="mt-1 block text-small text-muted-foreground" data-cron-words>{cronWords(value.trim())}</span>}
    </>
  );
}

/** The time zone input of a schedule: any IANA name, with the browser's zones to pick from. */
export function ZoneLine({ name, value, onChange, required }: { name: string; value: string; onChange: (value: string) => void; required?: boolean }) {
  return (
    <>
      <Input name={name} list={ZONES.length > 0 ? ZONE_LIST : undefined} value={value} onChange={(e) => onChange(e.target.value)} required={required} />
      {ZONES.length > 0 && <datalist id={ZONE_LIST}>{ZONES.map((z) => <option key={z} value={z} />)}</datalist>}
    </>
  );
}
