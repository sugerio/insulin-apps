// Form pieces shared by the pages, built from the shadcn/ui components. Every form is a plain HTML POST.
import * as React from "react"
import { CircleAlert, CircleCheck, Info } from "lucide-react"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { TurnstileAction } from "../turnstile.ts"

export interface TextFieldProps {
  label: string
  name: string
  type?: "text" | "email" | "password"
  value?: string | null
  autoComplete?: string
  /** Fields are required unless this is false. */
  required?: boolean
  hint?: React.ReactNode
  error?: string | null
  minLength?: number
  maxLength?: number
  readOnly?: boolean
  /** Shown at the end of the label's row, such as a "Forgot your password?" link. */
  labelAside?: React.ReactNode
}

/** A labelled input. Its hint and error are tied to it with aria-describedby, and an error sets aria-invalid. */
export function TextField(props: TextFieldProps) {
  const id = `field-${props.name}`
  const hintId = props.hint ? `${id}-hint` : undefined
  const errorId = props.error ? `${id}-error` : undefined
  const label = <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
  return (
    <Field data-invalid={props.error ? true : undefined}>
      {props.labelAside ? (
        <div className="flex items-center gap-2">
          {label}
          <div className="ml-auto text-sm">{props.labelAside}</div>
        </div>
      ) : (
        label
      )}
      <Input
        id={id}
        name={props.name}
        type={props.type ?? "text"}
        autoComplete={props.autoComplete}
        required={props.required !== false}
        minLength={props.minLength}
        maxLength={props.maxLength}
        readOnly={props.readOnly}
        aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
        aria-invalid={props.error ? true : undefined}
        defaultValue={props.value || undefined}
      />
      {props.hint ? <FieldDescription id={hintId}>{props.hint}</FieldDescription> : null}
      {/* Not an alert of its own: the error summary at the top of the form is the one alert. */}
      {props.error ? (
        <FieldError id={errorId} role={undefined}>
          {props.error}
        </FieldError>
      ) : null}
    </Field>
  )
}

export interface Choice {
  value: string
  label: string
}

/** A labelled native <select>, styled like shadcn's Select (NativeSelect). */
export function SelectField(props: { label: string; name: string; choices: Choice[]; selected?: string; id?: string; hint?: string }) {
  const id = props.id ?? `field-${props.name}`
  return (
    <Field>
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      <NativeSelect id={id} name={props.name} defaultValue={props.selected} aria-describedby={props.hint ? `${id}-hint` : undefined}>
        {props.choices.map((choice) => (
          <NativeSelectOption key={choice.value} value={choice.value}>
            {choice.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {props.hint ? <FieldDescription id={`${id}-hint`}>{props.hint}</FieldDescription> : null}
    </Field>
  )
}

export function Hidden({ name, value }: { name: string; value: string | null | undefined }) {
  return value ? <input type="hidden" name={name} defaultValue={value} /> : null
}

/**
 * Problems with a submitted form: a destructive Alert that screen readers announce and that takes focus on load.
 * Without problems, an empty polite live region stays in its place.
 */
export function ErrorSummary({ errors }: { errors: (string | null | undefined)[] }) {
  const list = errors.filter((error): error is string => Boolean(error))
  if (!list.length) return <div aria-live="polite" className="sr-only" />
  return (
    <Alert variant="destructive" aria-live="assertive" tabIndex={-1} autoFocus className="outline-none">
      <CircleAlert />
      <AlertTitle>{list.length === 1 ? "There is a problem" : "There are problems"}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4">
          {list.map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

/** A notice (role="status"): the default Alert, with a check mark for a completed action. */
export function Notice({ children, kind = "info", className }: { children: React.ReactNode; kind?: "info" | "ok"; className?: string }) {
  return (
    <Alert role="status" aria-live="polite" className={className}>
      {kind === "ok" ? <CircleCheck /> : <Info />}
      <AlertDescription className="text-card-foreground">{children}</AlertDescription>
    </Alert>
  )
}

/** Cloudflare Turnstile's widget (its script is loaded by the page); each form names its own action. */
export function TurnstileWidget({ siteKey, action }: { siteKey: string; action: TurnstileAction }) {
  return <div className="cf-turnstile" data-sitekey={siteKey} data-action={action} data-theme="auto" data-size="flexible" />
}

/** A one-button POST form. */
export function PostButton({
  action,
  fields = {},
  className,
  formClassName,
  ...button
}: React.ComponentProps<typeof Button> & { action: string; fields?: Record<string, string | null | undefined>; formClassName?: string }) {
  return (
    <form method="post" action={action} className={cn("inline-flex", formClassName)}>
      {Object.entries(fields).map(([name, value]) => (
        <Hidden key={name} name={name} value={value} />
      ))}
      <Button type="submit" className={className} {...button} />
    </form>
  )
}
