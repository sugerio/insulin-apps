import { useId, type ReactNode } from "react";
import { Check, CircleX, TriangleAlert } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldTitle } from "@/components/ui/field.tsx";
import { Input } from "@/components/ui/input.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { cn } from "@/lib/utils.ts";

// The form controls, on shadcn/ui's Field: a label with its required marker, the control, a hint, and the error the
// client or the server placed on the field. The control is labelled and described by them and marked aria-invalid, so
// a screen reader reads the error with the field, and ErrorFocus moves focus to the first field that gets one (and
// announces it once, so a field's error isn't an alert of its own).

interface FieldShell {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: string | undefined;
  className?: string;
}

/** The error under a field: shadcn/ui's FieldError, without its alert role (ErrorFocus announces errors). */
function ErrorText({ id, children }: { id: string; children: ReactNode }) {
  return <FieldError id={id} role={undefined}>{children}</FieldError>;
}

function Shell({ label, required, hint, error, className, id, children }: FieldShell & { id: string; children: ReactNode }) {
  return (
    <Field className={cn("min-w-0", className)} data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>
        {label}
        {required ? <span className="text-destructive" aria-hidden="true">*</span> : null}
      </FieldLabel>
      {children}
      {hint ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
      {error ? <ErrorText id={`${id}-err`}>{error}</ErrorText> : null}
    </Field>
  );
}

function describedBy(id: string, hint: ReactNode, error: string | undefined): string | undefined {
  const ids = [error ? `${id}-err` : null, hint ? `${id}-hint` : null].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

interface TextFieldProps extends FieldShell {
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "date" | "tel";
  placeholder?: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  prefix?: string;
  suffix?: string;
  /** Numbers are typed as text and read exactly (lib/amounts); this only picks the phone keyboard. */
  inputMode?: "decimal" | "numeric" | "email" | "text";
  autoComplete?: string;
  name?: string;
}

export function TextField({ label, required, hint, error, className, value, onChange, type = "text", placeholder, min, max, disabled, prefix, suffix, inputMode, autoComplete = "off", name }: TextFieldProps) {
  const id = useId();
  const control = {
    id,
    name,
    type,
    value,
    placeholder,
    min,
    max,
    disabled,
    inputMode,
    autoComplete,
    "aria-required": required || undefined,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy(id, hint, error),
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
  };
  return (
    <Shell id={id} label={label} required={required} hint={hint} error={error} className={className}>
      {prefix || suffix ? (
        <InputGroup>
          <InputGroupInput {...control} />
          {prefix ? <InputGroupAddon><InputGroupText aria-hidden="true">{prefix}</InputGroupText></InputGroupAddon> : null}
          {suffix ? <InputGroupAddon align="inline-end"><InputGroupText aria-hidden="true">{suffix}</InputGroupText></InputGroupAddon> : null}
        </InputGroup>
      ) : <Input {...control} />}
    </Shell>
  );
}

/** A decimal typed as text (never `type="number"`, which reads floats): quantities, prices, money. */
export function AmountField(props: Omit<TextFieldProps, "type" | "inputMode">) {
  return <TextField {...props} type="text" inputMode="decimal" />;
}

export function DateField(props: Omit<TextFieldProps, "type">) {
  return <TextField {...props} type="date" />;
}

interface SelectFieldProps extends FieldShell {
  value: string;
  onChange: (value: string) => void;
  options: readonly (readonly [value: string, label: string])[];
  placeholder?: string;
  disabled?: boolean;
}

/** A select, as shadcn/ui's NativeSelect: a real `<select>`, which reads well on every device and in tests. */
export function SelectField({ label, required, hint, error, className, value, onChange, options, placeholder, disabled }: SelectFieldProps) {
  const id = useId();
  return (
    <Shell id={id} label={label} required={required} hint={hint} error={error} className={className}>
      <NativeSelect
        id={id}
        className="w-full"
        value={value}
        disabled={disabled}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(event) => onChange(event.target.value)}
      >
        {placeholder !== undefined ? <NativeSelectOption value="">{placeholder}</NativeSelectOption> : null}
        {options.map(([option, text]) => <NativeSelectOption key={option} value={option}>{text}</NativeSelectOption>)}
      </NativeSelect>
    </Shell>
  );
}

export function TextAreaField({ label, required, hint, error, className, value, onChange, placeholder, rows = 3, disabled }: FieldShell & { value: string; onChange: (value: string) => void; placeholder?: string; rows?: number; disabled?: boolean }) {
  const id = useId();
  return (
    <Shell id={id} label={label} required={required} hint={hint} error={error} className={className}>
      <Textarea
        id={id}
        rows={rows}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(event) => onChange(event.target.value)}
      />
    </Shell>
  );
}

export interface RadioOption {
  value: string;
  label: ReactNode;
  sub?: ReactNode;
  disabled?: boolean;
}

/** Radio cards: shadcn/ui's RadioGroup, each choice a card that labels its radio. */
export function RadioCards({ label, value, onChange, options, error }: { label: string; value: string; onChange: (value: string) => void; options: readonly RadioOption[]; error?: string | undefined }) {
  const name = useId();
  return (
    <div className="flex flex-col gap-2">
      <RadioGroup
        aria-label={label}
        value={value}
        onValueChange={onChange}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-err` : undefined}
        className="grid gap-2 sm:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]"
      >
        {options.map((option, index) => {
          const id = `${name}-${index}`;
          return (
            <FieldLabel htmlFor={id} key={option.value}>
              <Field orientation="horizontal" data-disabled={option.disabled || undefined}>
                <RadioGroupItem id={id} value={option.value} disabled={option.disabled} aria-invalid={error ? true : undefined} aria-describedby={error ? `${name}-err` : undefined} />
                <FieldContent>
                  <FieldTitle>{option.label}</FieldTitle>
                  {option.sub ? <FieldDescription>{option.sub}</FieldDescription> : null}
                </FieldContent>
              </Field>
            </FieldLabel>
          );
        })}
      </RadioGroup>
      {error ? <ErrorText id={`${name}-err`}>{error}</ErrorText> : null}
    </div>
  );
}

/** A checkbox and its label: shadcn/ui's Checkbox in a horizontal Field. */
export function CheckLine({ checked, onChange, children, disabled, error }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode; disabled?: boolean; error?: string | undefined }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Field orientation="horizontal" data-disabled={disabled || undefined} data-invalid={error ? true : undefined}>
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          onCheckedChange={(next) => onChange(next === true)}
        />
        <FieldLabel htmlFor={id} className="font-normal">{children}</FieldLabel>
      </Field>
      {error ? <ErrorText id={`${id}-err`}>{error}</ErrorText> : null}
    </div>
  );
}

const BLOCK_ITEMS = {
  block: { icon: CircleX, className: "text-destructive" },
  warn: { icon: TriangleAlert, className: "text-amber-700 dark:text-amber-400" },
  ok: { icon: Check, className: "text-emerald-700 dark:text-emerald-400" },
} as const;

/** The errors the client or the server couldn't pin on a field: shown above the form, as a list. */
export function BlockList({ items, kind = "block" }: { items: readonly ReactNode[]; kind?: "block" | "warn" | "ok" }) {
  if (!items.length) return null;
  const { icon: Drawn, className } = BLOCK_ITEMS[kind];
  return (
    <div className="flex flex-col gap-1.5 text-sm" role={kind === "block" ? "alert" : undefined}>
      {items.map((item, index) => (
        <div className="flex items-start gap-2" key={index}>
          <Drawn className={cn("mt-0.5 size-4 shrink-0", className)} aria-hidden="true" />
          <span className="min-w-0">{item}</span>
        </div>
      ))}
    </div>
  );
}
