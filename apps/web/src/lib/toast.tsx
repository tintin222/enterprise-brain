import { clsx } from "clsx";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { errorMessage } from "../api.ts";

type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  link?: { to: string; label: string };
}

interface ToastOptions {
  description?: string;
  link?: { to: string; label: string };
  duration?: number;
}

interface ToastApi {
  success: (title: string, options?: ToastOptions) => void;
  error: (titleOrError: unknown, options?: ToastOptions) => void;
  info: (title: string, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (kind: ToastKind, title: string, options: ToastOptions = {}) => {
      const id = nextId.current++;
      setItems((list) => [...list.slice(-3), { id, kind, title, description: options.description, link: options.link }]);
      window.setTimeout(() => dismiss(id), options.duration ?? (kind === "error" ? 7000 : 4500));
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (title, options) => push("success", title, options),
      info: (title, options) => push("info", title, options),
      error: (titleOrError, options) => push("error", typeof titleOrError === "string" ? titleOrError : errorMessage(titleOrError), options),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:items-end">
        {items.map((t) => {
          const Icon = t.kind === "success" ? CircleCheck : t.kind === "error" ? CircleAlert : Info;
          return (
            <div
              key={t.id}
              role={t.kind === "error" ? "alert" : "status"}
              className="pointer-events-auto flex w-full max-w-sm animate-pop-in items-start gap-3 rounded-xl border border-line bg-surface p-3.5 shadow-lg shadow-slate-900/10 dark:shadow-black/40"
            >
              <Icon
                className={clsx(
                  "mt-0.5 size-5 shrink-0",
                  t.kind === "success" && "text-emerald-500",
                  t.kind === "error" && "text-red-500",
                  t.kind === "info" && "text-brand-500",
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">{t.title}</p>
                {t.description && <p className="mt-0.5 text-sm text-muted">{t.description}</p>}
                {t.link && (
                  <Link to={t.link.to} onClick={() => dismiss(t.id)} className="mt-1 inline-block text-sm font-medium text-brand-600 hover:underline dark:text-brand-300">
                    {t.link.label} →
                  </Link>
                )}
              </div>
              <button type="button" onClick={() => dismiss(t.id)} className="rounded p-0.5 text-faint hover:bg-subtle hover:text-fg" aria-label="Dismiss">
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
