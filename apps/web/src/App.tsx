import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation, useParams } from "react-router";
import { isApiError } from "./api.ts";
import { AppShell } from "./components/Layout.tsx";
import { LoadingBlock } from "./components/Spinner.tsx";
import { AuthGate } from "./lib/auth.tsx";
import { CompanyProvider } from "./lib/company.tsx";
import { ToastProvider } from "./lib/toast.tsx";
import { RouteError } from "./pages/RouteError.tsx";

const Home = lazy(() => import("./pages/Home.tsx"));
const Company = lazy(() => import("./pages/company/Company.tsx"));
const Performance = lazy(() => import("./pages/company/Performance.tsx"));
const AiEmployee = lazy(() => import("./pages/ai/AiEmployee.tsx"));
const Hire = lazy(() => import("./pages/hire/Hire.tsx"));
const BuilderNew = lazy(() => import("./pages/builder/BuilderNew.tsx"));
const BuilderSession = lazy(() => import("./pages/builder/BuilderSession.tsx"));
const StudioThread = lazy(() => import("./pages/studio/StudioThread.tsx"));
const Catalog = lazy(() => import("./pages/catalog/Catalog.tsx"));
const DepartmentDetail = lazy(() => import("./pages/catalog/DepartmentDetail.tsx"));
const Work = lazy(() => import("./pages/work/Work.tsx"));
const TaskPage = lazy(() => import("./pages/work/TaskPage.tsx"));
const SettingsLayout = lazy(() => import("./pages/settings/SettingsLayout.tsx"));
const Connectors = lazy(() => import("./pages/Connectors.tsx"));
const Knowledge = lazy(() => import("./pages/Knowledge.tsx"));
const People = lazy(() => import("./pages/People.tsx"));
const Costs = lazy(() => import("./pages/settings/Costs.tsx"));
const Channels = lazy(() => import("./pages/settings/Channels.tsx"));
const Inbox = lazy(() => import("./pages/Inbox.tsx"));
const ActivityPage = lazy(() => import("./pages/Activity.tsx"));
const Installation = lazy(() => import("./pages/settings/Installation.tsx"));
const Building = lazy(() => import("./pages/settings/Building.tsx"));
const Paperclip = lazy(() => import("./pages/Paperclip.tsx"));
const AnswerPage = lazy(() => import("./pages/AnswerPage.tsx"));
const ActPage = lazy(() => import("./pages/ActPage.tsx"));
const AgentApp = lazy(() => import("./pages/AgentApp.tsx"));
const RunDetail = lazy(() => import("./pages/runs/RunDetail.tsx"));
const Search = lazy(() => import("./pages/Search.tsx"));
const Assistant = lazy(() => import("./pages/Assistant.tsx"));
const UseCaseApp = lazy(() => import("./pages/UseCaseApp.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));
const Apps = lazy(() => import("./pages/apps/Apps.tsx"));
const TablePage = lazy(() => import("./pages/apps/TablePage.tsx"));
const AppPage = lazy(() => import("./pages/apps/AppPage.tsx"));
const CalculationPage = lazy(() => import("./pages/apps/CalculationPage.tsx"));
const SignIn = lazy(() => import("./pages/SignIn.tsx"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => !isApiError(error, 404) && !isApiError(error, 401) && !isApiError(error, 400) && count < 2,
    },
  },
});

/** Old address → where it lives now (":name" carries a route parameter over). */
const MOVED: Record<string, string> = {
  agents: "/company",
  "agents/:slug": "/ai/:slug",
  departments: "/company",
  builder: "/hire",
  "builder/new": "/hire/studio/new",
  "builder/:id": "/hire/studio/:id",
  catalog: "/hire/ready-made",
  "catalog/departments/:id": "/hire/ready-made/:id",
  approvals: "/work",
  runs: "/work?view=tasks",
  connectors: "/settings/connections",
  knowledge: "/settings/knowledge",
  people: "/settings/people",
  inbox: "/mail",
  "settings/mailboxes": "/mail",
  activity: "/settings/audit",
  paperclip: "/settings/paperclip",
};

/** Sends an old address to its new place, keeping its parameters, query and hash. */
function Moved({ to }: { to: string }) {
  const params = useParams();
  const location = useLocation();
  const [base = "/", query = ""] = to.replace(/:(\w+)/g, (_, key: string) => encodeURIComponent(params[key] ?? "")).split("?");
  const search = new URLSearchParams(query);
  new URLSearchParams(location.search).forEach((value, key) => search.set(key, value));
  const rest = search.toString();
  return <Navigate to={`${base}${rest ? `?${rest}` : ""}${location.hash}`} replace />;
}

/** Providers that need the router (toasts render <Link>s). */
function Root() {
  return (
    <ToastProvider>
      <Outlet />
    </ToastProvider>
  );
}

/** The console: signed-in person, company context and chrome. */
function Console() {
  return (
    <AuthGate>
      <CompanyProvider>
        <AppShell />
      </CompanyProvider>
    </AuthGate>
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
        // Public: the buttons of an approval email land here; the signed link is the credential.
        path: "/act/:token",
        element: (
          <Suspense fallback={<LoadingBlock className="min-h-screen" />}>
            <ActPage />
          </Suspense>
        ),
      },
      {
        path: "/signin",
        element: (
          <Suspense fallback={<LoadingBlock className="min-h-screen" />}>
            <SignIn />
          </Suspense>
        ),
      },
      {
        path: "/",
        element: <Console />,
        errorElement: <RouteError />,
        children: [
          { index: true, element: <Home /> },
          { path: "company", element: <Company /> },
          { path: "company/performance", element: <Performance /> },
          { path: "ai/:slug", element: <AiEmployee /> },
          { path: "hire", element: <Hire /> },
          { path: "hire/studio/new", element: <BuilderNew /> },
          { path: "hire/studio/:id", element: <BuilderSession /> },
          { path: "studio/:id", element: <StudioThread /> },
          { path: "hire/ready-made", element: <Catalog /> },
          { path: "hire/ready-made/:id", element: <DepartmentDetail /> },
          { path: "work", element: <Work /> },
          { path: "work/:ref", element: <TaskPage /> },
          { path: "mail", element: <Inbox /> },
          { path: "apps", element: <Apps /> },
          { path: "tables/:key", element: <TablePage /> },
          { path: "calculations/:key", element: <CalculationPage /> },
          {
            path: "settings",
            element: <SettingsLayout />,
            children: [
              { path: "connections", element: <Connectors /> },
              { path: "channels", element: <Channels /> },
              { path: "knowledge", element: <Knowledge /> },
              { path: "people", element: <People /> },
              { path: "costs", element: <Costs /> },
              { path: "building", element: <Building /> },
              { path: "audit", element: <ActivityPage /> },
              { path: "installation", element: <Installation /> },
              { path: "paperclip", element: <Paperclip /> },
            ],
          },
          { path: "ai/:slug/app", element: <AgentApp /> },
          { path: "apps/:key", element: <AppPage /> },
          { path: "runs/:id", element: <RunDetail /> },
          { path: "assistant", element: <Assistant /> },
          { path: "search", element: <Search /> },
          { path: "documents", element: <UseCaseApp kind="documents" /> },
          { path: "excel", element: <UseCaseApp kind="excel" /> },
          // Addresses from before the five places keep working.
          ...Object.entries(MOVED).map(([path, to]) => ({ path, element: <Moved to={to} /> })),
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
