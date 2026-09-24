import { TriangleAlert } from "lucide-react";
import { isRouteErrorResponse, Link, useRouteError } from "react-router";
import { errorMessage } from "../api.ts";

/** Last-resort error screen for rendering errors and failed lazy chunks. */
export function RouteError() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : undefined;
  const chunk = error instanceof Error && /dynamically imported module|Loading chunk|Importing a module script failed/i.test(error.message);
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-amber-50 text-amber-600 dark:bg-amber-400/10 dark:text-amber-300">
          <TriangleAlert className="size-6" />
        </div>
        <h1 className="text-lg font-semibold">{status === 404 ? "Page not found" : chunk ? "A new version is available" : "This page crashed"}</h1>
        <p className="mt-2 text-sm break-words text-muted">
          {chunk
            ? "The console was updated while this tab was open. Reload to continue."
            : isRouteErrorResponse(error)
              ? error.statusText
              : errorMessage(error)}
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Reload
          </button>
          <Link to="/" className="rounded-lg border border-line-strong px-4 py-2 text-sm font-medium hover:bg-subtle">
            Go to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
