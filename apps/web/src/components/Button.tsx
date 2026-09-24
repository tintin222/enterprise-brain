import { clsx } from "clsx";
import { LoaderCircle, type LucideIcon } from "lucide-react";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success" | "soft";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors select-none " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:pointer-events-none disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-brand-600 text-white shadow-sm shadow-brand-900/10 hover:bg-brand-700 dark:bg-brand-500 dark:hover:bg-brand-400",
  secondary: "border border-line-strong bg-surface text-fg shadow-xs hover:bg-subtle",
  ghost: "text-muted hover:bg-subtle hover:text-fg",
  danger: "bg-red-600 text-white shadow-sm hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-400",
  success: "bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400",
  soft: "bg-brand-50 text-brand-700 hover:bg-brand-100 dark:bg-brand-500/15 dark:text-brand-200 dark:hover:bg-brand-500/25",
};

const sizes: Record<ButtonSize, string> = {
  xs: "h-7 px-2 text-xs",
  sm: "h-8 px-2.5 text-[13px]",
  md: "h-9 px-3.5 text-sm",
  lg: "h-11 px-5 text-[15px]",
};

const iconSizes: Record<ButtonSize, string> = { xs: "size-3.5", sm: "size-4", md: "size-4", lg: "size-[18px]" };

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className?: string): string {
  return clsx(base, variants[variant], sizes[size], className);
}

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  loading?: boolean;
  children?: ReactNode;
}

export interface ButtonProps extends CommonProps, Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {}

export function Button({
  variant = "secondary",
  size = "md",
  icon: Icon,
  iconRight: IconRight,
  loading,
  className,
  children,
  disabled,
  type,
  ...rest
}: ButtonProps) {
  return (
    <button type={type ?? "button"} className={buttonClass(variant, size, className)} disabled={disabled || loading} {...rest}>
      {loading ? <LoaderCircle className={clsx(iconSizes[size], "animate-spin")} /> : Icon ? <Icon className={iconSizes[size]} /> : null}
      {children}
      {IconRight && !loading && <IconRight className={iconSizes[size]} />}
    </button>
  );
}

export interface ButtonLinkProps extends CommonProps {
  to: string;
  className?: string;
  title?: string;
  target?: string;
  onClick?: () => void;
}

/** A react-router Link styled as a button. */
export function ButtonLink({ to, variant = "secondary", size = "md", icon: Icon, iconRight: IconRight, className, children, ...rest }: ButtonLinkProps) {
  return (
    <Link to={to} className={buttonClass(variant, size, className)} {...rest}>
      {Icon && <Icon className={iconSizes[size]} />}
      {children}
      {IconRight && <IconRight className={iconSizes[size]} />}
    </Link>
  );
}

export interface ButtonAnchorProps extends CommonProps, Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children"> {}

/** A plain <a> (external links, downloads) styled as a button. */
export function ButtonAnchor({ variant = "secondary", size = "md", icon: Icon, iconRight: IconRight, className, children, ...rest }: ButtonAnchorProps) {
  return (
    <a className={buttonClass(variant, size, className)} {...rest}>
      {Icon && <Icon className={iconSizes[size]} />}
      {children}
      {IconRight && <IconRight className={iconSizes[size]} />}
    </a>
  );
}

/** Square icon-only button with an accessible label. */
export function IconButton({
  icon: Icon,
  label,
  className,
  size = "md",
  ...rest
}: { icon: LucideIcon; label: string; size?: "sm" | "md" } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx(
        "inline-flex items-center justify-center rounded-lg text-muted transition-colors hover:bg-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-brand-500 disabled:opacity-50",
        size === "sm" ? "size-7" : "size-9",
        className,
      )}
      {...rest}
    >
      <Icon className={size === "sm" ? "size-4" : "size-[18px]"} />
    </button>
  );
}
