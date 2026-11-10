import * as React from "react";
import { cn } from "@/lib/utils";

/** What a Field tells the control inside it: its id (the label points at it), what describes it, and whether it is
 *  refused. A control outside a Field gets nothing and takes its own props. */
type FieldWiring = { id: string; describedBy?: string; invalid: boolean; required: boolean };
const FieldContext = React.createContext<FieldWiring | null>(null);

/** A Field's wiring for a control that is not one of this file's (the Picker): the id its label points at, and what
 *  describes it. Null outside a Field. */
export const useFieldWiring = () => React.useContext(FieldContext);

function useWiring<P extends { id?: string; required?: boolean; "aria-describedby"?: string; "aria-invalid"?: React.AriaAttributes["aria-invalid"]; "aria-required"?: React.AriaAttributes["aria-required"] }>(props: P) {
  const wiring = React.useContext(FieldContext);
  return {
    id: props.id ?? wiring?.id,
    "aria-describedby": props["aria-describedby"] ?? wiring?.describedBy,
    "aria-invalid": props["aria-invalid"] ?? (wiring?.invalid || undefined),
    // The label's asterisk is hidden from a screen reader; the control says "required" itself.
    "aria-required": props["aria-required"] ?? ((wiring?.required && !props.required) || undefined),
  };
}

/** A form field: the label, an optional note under it, the control, an optional hint, then what is wrong with it. The
 *  label names the control and the note, the hint and the error describe it, so a screen reader reads them with the
 *  control. `note` says what the field is for, before the control; `hint` answers what was typed (a parsed time, a
 *  minimum), after it.
 *  `id`: the control's id, when something else must know it; give it here, not on the control, or the label points at
 *  nothing.
 *  `group`: the field holds several controls (a set of radios, a list of checkboxes), so its heading names the group.
 *  `group="heading"`: what it holds names itself (a radiogroup with its own label), so the heading is only seen. */
export function Field({ label, id, required, optional, note, hint, error, warning, aside, group, className, children }: {
  label: React.ReactNode; id?: string; required?: boolean; optional?: boolean; note?: React.ReactNode; hint?: React.ReactNode; error?: React.ReactNode; warning?: React.ReactNode;
  aside?: React.ReactNode; group?: boolean | "heading"; className?: string; children: React.ReactNode;
}) {
  const auto = React.useId();
  const control = id ?? `${auto}-control`;
  const [labelId, noteId, hintId, errorId, warningId] = [`${auto}-label`, `${auto}-note`, `${auto}-hint`, `${auto}-error`, `${auto}-warning`];
  const describedBy = [note && noteId, hint && hintId, error && errorId, warning && warningId].filter(Boolean).join(" ") || undefined;
  const heading = <>{label}{required && <span className="text-destructive-text" aria-hidden> *</span>}{optional && <span className="font-normal normal-case text-muted-foreground"> (optional)</span>}</>;
  return (
    <div className={className} {...(group === true ? { role: "group", "aria-labelledby": labelId, "aria-describedby": describedBy } : {})}>
      <div className="mb-2 flex items-center justify-between gap-3">
        {group
          ? <span id={labelId} className="caps text-small font-semibold">{heading}</span>
          : <label id={labelId} htmlFor={control} className="caps text-small font-semibold">{heading}</label>}
        {aside}
      </div>
      {note && <p id={noteId} className="-mt-1 mb-2 text-small text-muted-foreground">{note}</p>}
      <FieldContext.Provider value={group ? null : { id: control, describedBy, invalid: !!error, required: !!required }}>{children}</FieldContext.Provider>
      {hint && <p id={hintId} className="mt-1.5 text-small text-muted-foreground">{hint}</p>}
      {error && <p id={errorId} className="mt-2 font-mono text-small text-destructive-text" role="alert">{error}</p>}
      {warning && <p id={warningId} className="mt-2 font-mono text-small text-warning-text">{warning}</p>}
    </div>
  );
}

/** What every text control shares: the field's edge (3:1 against the page), mono text, and a refused field in red. */
export const fieldClass = "w-full border border-input bg-background px-3 font-mono text-body placeholder:text-muted-foreground hover:border-foreground/60 focus-visible:outline-offset-0 read-only:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-45 aria-[invalid=true]:border-destructive";

/** The text of a field whose edge something else draws: a search box with an icon in it, a composer with its buttons
 *  under the text. Put the control in a `fieldBoxClass` box, which shows the focus for it. */
export const bareFieldClass = "min-w-0 bg-transparent font-mono text-body outline-none placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed";
/** The box round a `bare` control and what sits beside it: the field's edge, and the focus ring while the control has it. */
export const fieldBoxClass = "border border-input bg-background hover:border-foreground/60 focus-within:outline focus-within:outline-focus focus-within:outline-ring";

/** A one-line text field. `fieldSize`: sm (32px) for a toolbar, md (40px) for a form. `bare`: only the text, inside a
 *  box that draws the edge (`fieldBoxClass`). */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { fieldSize?: "sm" | "md"; bare?: boolean }>(({ className, fieldSize = "md", bare, ...props }, ref) => (
  <input ref={ref} {...props} {...useWiring(props)} className={cn(bare ? bareFieldClass : cn(fieldClass, fieldSize === "sm" ? "h-control-sm" : "h-control-md"), className)} />
));
Input.displayName = "Input";

/** A text field of several lines. */
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { bare?: boolean }>(({ className, bare, ...props }, ref) => (
  <textarea ref={ref} {...props} {...useWiring(props)} className={cn(bare ? bareFieldClass : cn(fieldClass, "py-2.5"), className)} />
));
Textarea.displayName = "Textarea";

type Choice = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & { label: React.ReactNode; note?: React.ReactNode };
const choice = (type: "checkbox" | "radio") => {
  const C = React.forwardRef<HTMLInputElement, Choice>(({ label, note, className, disabled, ...props }, ref) => (
    <label className={cn("flex items-start gap-2.5 text-body", disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer", className)}>
      <input ref={ref} type={type} disabled={disabled} {...props} {...useWiring(props)} className="mt-0.5 size-4 shrink-0 accent-primary" />
      <span className="min-w-0"><span className="block">{label}</span>{note && <span className="mt-0.5 block text-small text-muted-foreground">{note}</span>}</span>
    </label>
  ));
  C.displayName = type === "checkbox" ? "Checkbox" : "Radio";
  return C;
};

/** A checkbox with its words: the label is the click target, the note says what ticking it does. */
export const Checkbox = choice("checkbox");
/** One choice of a set (the same `name`), with its words. Wrap the set in a `<Field group>`. */
export const Radio = choice("radio");
