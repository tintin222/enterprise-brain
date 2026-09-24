import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router";
import { isApiError } from "./api.ts";
import { AppShell } from "./components/Layout.tsx";
import { LoadingBlock } from "./components/Spinner.tsx";
import { CompanyProvider } from "./lib/company.tsx";
import { ToastProvider } from "./lib/toast.tsx";
import { RouteError } from "./pages/RouteError.tsx";

const Dashboard = lazy(() => import("./pages/Dashboard.tsx"));
const BuilderList = lazy(() => import("./pages/builder/BuilderList.tsx"));
const BuilderNew = lazy(() => import("./pages/builder/BuilderNew.tsx"));
const BuilderSession = lazy(() => import("./pages/builder/BuilderSession.tsx"));
const AnswerPage = lazy(() => import("./pages/AnswerPage.tsx"));
const AgentApp = lazy(() => import("./pages/AgentApp.tsx"));
const AgentsList = lazy(() => import("./pages/agents/AgentsList.tsx"));
const AgentDetail = lazy(() => import("./pages/agents/AgentDetail.tsx"));
const RunsList = lazy(() => import("./pages/runs/RunsList.tsx"));
const RunDetail = lazy(() => import("./pages/runs/RunDetail.tsx"));
const Approvals = lazy(() => import("./pages/Approvals.tsx"));
const Inbox = lazy(() => import("./pages/Inbox.tsx"));
const Knowledge = lazy(() => import("./pages/Knowledge.tsx"));
const Search = lazy(() => import("./pages/Search.tsx"));
const Assistant = lazy(() => import("./pages/Assistant.tsx"));
const UseCaseApp = lazy(() => import("./pages/UseCaseApp.tsx"));
const Catalog = lazy(() => import("./pages/catalog/Catalog.tsx"));
const DepartmentDetail = lazy(() => import("./pages/catalog/DepartmentDetail.tsx"));
const Departments = lazy(() => import("./pages/Departments.tsx"));
const Connectors = lazy(() => import("./pages/Connectors.tsx"));
const Paperclip = lazy(() => import("./pages/Paperclip.tsx"));
const ActivityPage = lazy(() => import("./pages/Activity.tsx"));
const SettingsPage = lazy(() => import("./pages/Settings.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => !isApiError(error, 404) && !isApiError(error, 401) && !isApiError(error, 400) && count < 2,
    },
  },
});

/** Providers that need the router (toasts render <Link>s). */
function Root() {
  return (
    <ToastProvider>
      <Outlet />
    </ToastProvider>
  );
}

/** The console: company context + chrome. */
function Console() {
  return (
    <CompanyProvider>
      <AppShell />
    </CompanyProvider>
  );
}

const router = createBrowserRouter([
  {
    element: <Root />,
    errorElement: <RouteError />,
    children: [
      {
        // Public stakeholder page: no console chrome, no API key needed.
        path: "/answer/:token",
        element: (
          <Suspense fallback={<LoadingBlock className="min-h-screen" />}>
            <AnswerPage />
          </Suspense>
        ),
      },
      {
        path: "/",
        element: <Console />,
        errorElement: <RouteError />,
        children: [
          { index: true, element: <Dashboard /> },
          { path: "builder", element: <BuilderList /> },
          { path: "builder/new", element: <BuilderNew /> },
          { path: "builder/:id", element: <BuilderSession /> },
          { path: "catalog", element: <Catalog /> },
          { path: "catalog/departments/:id", element: <DepartmentDetail /> },
          { path: "agents", element: <AgentsList /> },
          { path: "agents/:slug", element: <AgentDetail /> },
          { path: "apps/:slug", element: <AgentApp /> },
          { path: "runs", element: <RunsList /> },
          { path: "runs/:id", element: <RunDetail /> },
          { path: "approvals", element: <Approvals /> },
          { path: "inbox", element: <Inbox /> },
          { path: "assistant", element: <Assistant /> },
          { path: "search", element: <Search /> },
          { path: "knowledge", element: <Knowledge /> },
          { path: "documents", element: <UseCaseApp kind="documents" /> },
          { path: "excel", element: <UseCaseApp kind="excel" /> },
          { path: "connectors", element: <Connectors /> },
          { path: "paperclip", element: <Paperclip /> },
          { path: "departments", element: <Departments /> },
          { path: "activity", element: <ActivityPage /> },
          { path: "settings", element: <SettingsPage /> },
          { path: "*", element: <NotFound /> },
        ],
      },
    ],
  },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
