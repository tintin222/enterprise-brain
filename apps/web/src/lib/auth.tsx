import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { api, SIGNED_OUT_EVENT } from "../api.ts";
import type { AuthState, Viewer } from "../types.ts";
import { Splash } from "./company.tsx";

export function useAuthState() {
  return useQuery({ queryKey: ["auth"], queryFn: () => api.get<AuthState>("/api/auth/state"), staleTime: 60_000, retry: 1 });
}

/** The signed-in person; the owner in open mode; null while loading or signed out. */
export function useViewer(): Viewer | null {
  return useAuthState().data?.viewer ?? null;
}

/** "/signin?returnTo=/agents/x" for the page the person was on. */
export function signInPath(returnTo: string): string {
  return returnTo && returnTo !== "/" && !returnTo.startsWith("/signin") ? `/signin?returnTo=${encodeURIComponent(returnTo)}` : "/signin";
}

/** Sends people who aren't signed in to /signin, and back to where they were afterwards. */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuthState();
  const location = useLocation();
  const queryClient = useQueryClient();
  useEffect(() => {
    const recheck = () => void queryClient.invalidateQueries({ queryKey: ["auth"] });
    window.addEventListener(SIGNED_OUT_EVENT, recheck);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, recheck);
  }, [queryClient]);
  if (auth.isLoading) return <Splash />;
  // An unreachable server falls through: the console shows its own "can't reach the server" page.
  if (auth.data?.mode === "accounts" && !auth.data.viewer) return <Navigate to={signInPath(location.pathname + location.search)} replace />;
  return <>{children}</>;
}

export async function signOut(queryClient: QueryClient): Promise<void> {
  await api.post("/api/auth/signout").catch(() => undefined);
  queryClient.clear();
  window.location.assign("/signin");
}
