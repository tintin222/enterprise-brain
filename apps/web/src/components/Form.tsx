import { clsx } from "clsx";
import { useId, type ReactNode } from "react";

/** Label + control + help text. Pass a render function to receive the generated id. */
export function Field({
  label,
  hint,
  required,
  error,
  className,
  children,
  htmlFor,
  optional,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  optional?: boolean;
  error?: ReactNode;
  className?: string;
  htmlFor?: string;
  children: ReactNode | ((id: string) => ReactNode);
}) {
  const generated = useId();
  const id = htmlFor ?? generated;
  return (
    <div className={className}>
      {label && (
        <label htmlFor={id} className="label">
          {label}
          {required && (
            <span className="ml-0.5 text-red-500" aria-hidden="true">
              *
            </span>
          )}
          {optional && <span className="ml-1.5 text-xs font-normal text-faint">optional</span>}
        </label>
      )}
      {typeof children === "function" ? children(id) : children}
      {error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p> : hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  id,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const generated = useId();
  const switchId = id ?? generated;
  return (
    <div className={clsx("flex items-start gap-3", className)}>
      <button
        id={switchId}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
          checked ? "bg-brand-600 dark:bg-brand-500" : "bg-slate-300 dark:bg-slate-600",
        )}
      >
        <span className={clsx("inline-block size-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
      </button>
      {(label || description) && (
        <label htmlFor={switchId} className="min-w-0 cursor-pointer text-sm">
          {label && <span className="font-medium text-fg">{label}</span>}
          {description && <span className="block text-xs text-muted">{description}</span>}
        </label>
      )}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={clsx("flex items-start gap-2.5", className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 rounded border-line-strong accent-brand-600"
      />
      <label htmlFor={id} className="min-w-0 cursor-pointer text-sm">
        <span className="text-fg">{label}</span>
        {description && <span className="block text-xs text-muted">{description}</span>}
      </label>
    </div>
  );
}

/** Selectable chip (radio or toggle). */
export function Chip({
  selected,
  onClick,
  children,
  disabled,
  title,
  className,
  role = "button",
}: {
  selected?: boolean;
  onClick?: () => void;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
  className?: string;
  role?: "button" | "radio" | "checkbox";
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === "button" ? undefined : Boolean(selected)}
      aria-pressed={role === "button" ? Boolean(selected) : undefined}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={clsx(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-medium transition-colors disabled:opacity-50",
        selected
          ? "border-brand-500 bg-brand-600 text-white shadow-sm dark:border-brand-400 dark:bg-brand-500"
          : "border-line-strong bg-surface text-fg hover:border-brand-400 hover:bg-brand-50 dark:hover:bg-brand-400/10",
        className,
      )}
    >
      {children}
    </button>
  );
}
