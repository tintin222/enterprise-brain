import { clsx } from "clsx";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./Button.tsx";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

/** Copies `text` and briefly shows a check mark. Icon-only unless a label is given. */
export function CopyButton({
  text,
  label,
  copiedLabel = "Copied",
  variant = "secondary",
  size = "sm",
  className,
  iconOnly,
}: {
  text: string | (() => string);
  label?: string;
  copiedLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  iconOnly?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    const ok = await copyText(typeof text === "function" ? text() : text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  };
  const Icon = copied ? Check : Copy;
  if (iconOnly || !label) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={copied ? copiedLabel : (label ?? "Copy")}
        title={copied ? copiedLabel : (label ?? "Copy")}
        className={clsx("inline-flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-subtle hover:text-fg", className)}
      >
        <Icon className={clsx("size-3.5", copied && "text-emerald-500")} />
      </button>
    );
  }
  return (
    <button type="button" onClick={onClick} className={buttonClass(variant, size, className)}>
      <Icon className={clsx("size-4", copied && "text-emerald-500")} />
      {copied ? copiedLabel : label}
    </button>
  );
}
