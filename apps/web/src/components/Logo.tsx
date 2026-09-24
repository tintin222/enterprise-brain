import { clsx } from "clsx";
import { useId } from "react";

/** The Enterprise Brain mark: a two-hemisphere brain with connected nodes on a gradient tile. */
export function Logo({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 32 32" fill="none" className={clsx("shrink-0", className)} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6366f1" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-g)`} />
      <path
        d="M13 8.5a3.5 3.5 0 0 0-3.4 2.7A3.6 3.6 0 0 0 7.5 17a3.6 3.6 0 0 0 2.4 5.2A3.5 3.5 0 0 0 16 23.5V10a3 3 0 0 0-3-1.5Z"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M19 8.5a3.5 3.5 0 0 1 3.4 2.7A3.6 3.6 0 0 1 24.5 17a3.6 3.6 0 0 1-2.4 5.2A3.5 3.5 0 0 1 16 23.5V10a3 3 0 0 1 3-1.5Z"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M12.3 15h-2M19.7 18h2.2M16 13.5h-1.6M16 19.5h1.6" stroke="#fff" strokeOpacity=".75" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="12.3" cy="15" r="1.25" fill="#fff" />
      <circle cx="19.7" cy="18" r="1.25" fill="#fff" />
      <path d="M25.6 5.2l.45 1.05 1.05.45-1.05.45-.45 1.05-.45-1.05-1.05-.45 1.05-.45.45-1.05Z" fill="#fff" />
    </svg>
  );
}

export function Wordmark({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={clsx("flex items-center gap-2.5", className)}>
      <Logo className="size-8" />
      {!compact && (
        <span className="leading-tight">
          <span className="block text-[15px] font-semibold tracking-tight text-fg">Enterprise Brain</span>
          <span className="block text-[11px] font-medium text-muted">Agentic AI operating layer</span>
        </span>
      )}
    </span>
  );
}
