import { useId, type ReactNode } from "react";

// The form controls: a label with its required
// marker, the control, a hint, and the error the client or the server placed on the field. The control is labelled and
// described by them and marked aria-invalid, so a screen reader reads the error with the field, and ErrorFocus moves
// focus to the first field that gets one.

interface FieldShell {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: string | undefined;
  className?: string;
}

function Shell({ label, required, hint, error, className, id, children }: FieldShell & { id: string; children: ReactNode }) {
  return (
    <div className={className ? `fld ${className}` : "fld"}>
      <label htmlFor={id}>
        {label}
        {required ? <span className="req" aria-hidden="true">*</span> : null}
      </label>
      {children}
      {hint ? <div className="hint" id={`${id}-hint`}>{hint}</div> : null}
      {error ? <div className="err" id={`${id}-err`}>{error}</div> : null}
    </div>
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
  const input = (
    <input
      id={id}
      name={name}
      className="inp"
      type={type}
      value={value}
      placeholder={placeholder}
      min={min}
      max={max}
      disabled={disabled}
      inputMode={inputMode}
      autoComplete={autoComplete}
      aria-required={required || undefined}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(id, hint, error)}
      onChange={(event) => onChange(event.target.value)}
    />
  );
  return (
    <Shell id={id} label={label} required={required} hint={hint} error={error} className={className}>
      {prefix || suffix ? (
        <div className="inp-affix">
          {prefix ? <span className="affix" aria-hidden="true">{prefix}</span> : null}
          {input}
          {suffix ? <span className="affix" aria-hidden="true">{suffix}</span> : null}
        </div>
      ) : input}
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

export function SelectField({ label, required, hint, error, className, value, onChange, options, placeholder, disabled }: SelectFieldProps) {
  const id = useId();
  return (
    <Shell id={id} label={label} required={required} hint={hint} error={error} className={className}>
      <select
        id={id}
        className="inp"
        value={value}
        disabled={disabled}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(event) => onChange(event.target.value)}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map(([option, text]) => <option key={option} value={option}>{text}</option>)}
      </select>
    </Shell>
  );
}

export function TextAreaField({ label, required, hint, error, className, value, onChange, placeholder, rows = 3, disabled }: FieldShell & { value: string; onChange: (value: string) => void; placeholder?: string; rows?: number; disabled?: boolean }) {
  const id = useId();
  return (
    <Shell id={id} label={label} required={required} hint={hint} error={error} className={className}>
      <textarea
        id={id}
        className="inp"
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

/** Radio cards, as a labelled radio group. */
export function RadioCards({ label, value, onChange, options, error }: { label: string; value: string; onChange: (value: string) => void; options: readonly RadioOption[]; error?: string | undefined }) {
  const name = useId();
  return (
    <div>
      <div className="radios" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <label className="radio-card" key={option.value}>
            <input type="radio" name={name} value={option.value} checked={value === option.value} disabled={option.disabled} onChange={() => onChange(option.value)}
              aria-invalid={error ? true : undefined} aria-describedby={error ? `${name}-err` : undefined} />
            <span>
              <span className="rc-t">{option.label}</span>
              {option.sub ? <span className="rc-s">{option.sub}</span> : null}
            </span>
          </label>
        ))}
      </div>
      {error ? <div className="err-inline" id={`${name}-err`}>{error}</div> : null}
    </div>
  );
}

export function CheckLine({ checked, onChange, children, disabled, error }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode; disabled?: boolean; error?: string | undefined }) {
  const id = useId();
  return (
    <div>
      <label className="check-line">
        <input type="checkbox" checked={checked} disabled={disabled} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined} onChange={(event) => onChange(event.target.checked)} />
        <span>{children}</span>
      </label>
      {error ? <div className="err-inline" id={`${id}-err`}>{error}</div> : null}
    </div>
  );
}

/** The errors the client or the server couldn't pin on a field: shown above the form, as a list. */
export function BlockList({ items, kind = "block" }: { items: readonly ReactNode[]; kind?: "block" | "warn" | "ok" }) {
  if (!items.length) return null;
  return (
    <div className="warn-list" role={kind === "block" ? "alert" : undefined}>
      {items.map((item, index) => (
        <div className={kind === "warn" ? "warn-item" : `warn-item ${kind}`} key={index}>
          <span aria-hidden="true">{kind === "block" ? "✕" : kind === "ok" ? "✓" : "!"}</span>
          <span>{item}</span>
        </div>
      ))}
    </div>
  );
}
