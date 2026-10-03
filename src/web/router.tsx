import { PaginationSchema } from "../import-review/contract";
import { AccountPaginationSchema } from "../access/contract";
import type { ReactNode } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Navigate,
  Outlet,
} from "@tanstack/react-router";
import { StaffInvoicePage } from "./billing/workflow";
import { BillingSchedulePage } from "./billing/schedule";
import { SubscriptionsPage, SubscriptionPage } from "./billing/subscriptions";
import { Invoices } from "./billing/invoices";
import { ImportReview } from "./import-review/viewer";
import { useSession } from "./accounts/api";
import { ServicesPage, ServicePage } from "./services/pages";
import {
  SignOutButton,
  SignIn,
  CustomersPage,
  CustomerPage,
  AcceptInvitation,
} from "./accounts/pages";

interface ImportReviewSearch {
  sourceId?: string;
  importId?: string;
  customerId?: string;
  sourcesOffset: number;
  importsOffset: number;
  customersOffset: number;
  detailsOffset: number;
  dataIssuesOffset: number;
}

function offset(
  value: unknown,
  maximum = PaginationSchema.properties.offset.maximum!,
): number {
  const number = Number(value ?? 0);
  return Number.isInteger(number) && number >= 0 && number <= maximum
    ? number
    : 0;
}

function forecastSearch(search: Record<string, unknown>): {
  fromDueDate?: string;
  throughDueDate?: string;
  forecastOffset?: number;
} {
  const calendarDate = (value: unknown): value is string => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
      return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  };
  if (
    !calendarDate(search.fromDueDate) ||
    !calendarDate(search.throughDueDate) ||
    search.fromDueDate > search.throughDueDate
  )
    return {};
  return {
    fromDueDate: search.fromDueDate,
    throughDueDate: search.throughDueDate,
    forecastOffset: offset(
      search.forecastOffset,
      AccountPaginationSchema.properties.offset.maximum!,
    ),
  };
}

const importReviewStart = {
  sourcesOffset: 0,
  importsOffset: 0,
  customersOffset: 0,
  detailsOffset: 0,
  dataIssuesOffset: 0,
};

const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: NotFound,
});

function validateImportReviewSearch(
  search: Record<string, unknown>,
): ImportReviewSearch {
  return {
    sourceId: typeof search.sourceId === "string" ? search.sourceId : undefined,
    importId: typeof search.importId === "string" ? search.importId : undefined,
    customerId:
      typeof search.customerId === "string" ? search.customerId : undefined,
    sourcesOffset: offset(search.sourcesOffset),
    importsOffset: offset(search.importsOffset),
    customersOffset: offset(search.customersOffset),
    detailsOffset: offset(search.detailsOffset),
    dataIssuesOffset: offset(search.dataIssuesOffset),
  };
}

const entryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: validateImportReviewSearch,
  component: Entry,
});

const importReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/import-review",
  validateSearch: validateImportReviewSearch,
  component: StaffImportReview,
});

const invoicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invoices",
  validateSearch: (
    search: Record<string, unknown>,
  ): { invoiceId?: string; offset: number } => ({
    invoiceId:
      typeof search.invoiceId === "string" ? search.invoiceId : undefined,
    offset: offset(search.offset),
  }),
  component: Invoices,
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  component: SignIn,
});
const customersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/customers",
  component: CustomersPage,
});
const customerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/customers/$customerId",
  component: () => {
    const { customerId } = customerRoute.useParams();
    return <CustomerPage customerId={customerId} />;
  },
});
const invitationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invitations/$invitationId",
  component: () => {
    const { invitationId } = invitationRoute.useParams();
    return <AcceptInvitation invitationId={invitationId} />;
  },
});
const servicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/customers/$customerId/services",
  component: () => {
    const { customerId } = servicesRoute.useParams();
    return <ServicesPage key={customerId} customerId={customerId} />;
  },
});
const serviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/customers/$customerId/services/$serviceId",
  component: () => {
    const { customerId, serviceId } = serviceRoute.useParams();
    return (
      <ServicePage
        key={`${customerId}:${serviceId}`}
        customerId={customerId}
        serviceId={serviceId}
      />
    );
  },
});
const prepareInvoiceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/customers/$customerId/invoices/new",
  component: () => {
    const { customerId } = prepareInvoiceRoute.useParams();
    return <StaffInvoicePage customerId={customerId} />;
  },
});
const reviewInvoiceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/customers/$customerId/invoices/$invoiceId/review",
  component: () => {
    const { customerId, invoiceId } = reviewInvoiceRoute.useParams();
    return <StaffInvoicePage customerId={customerId} invoiceId={invoiceId} />;
  },
});
const billingScheduleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/customers/$customerId/billing-schedule",
  validateSearch: (
    search: Record<string, unknown>,
  ): { fromDueDate?: string; throughDueDate?: string; offset?: number } => ({
    fromDueDate:
      typeof search.fromDueDate === "string" ? search.fromDueDate : undefined,
    throughDueDate:
      typeof search.throughDueDate === "string"
        ? search.throughDueDate
        : undefined,
    offset: offset(search.offset),
  }),
  component: () => {
    const { customerId } = billingScheduleRoute.useParams();
    return <BillingSchedulePage key={customerId} customerId={customerId} />;
  },
});
const subscriptionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/customers/$customerId/subscriptions",
  validateSearch: forecastSearch,
  component: () => {
    const { customerId } = subscriptionsRoute.useParams();
    return <SubscriptionsPage key={customerId} customerId={customerId} />;
  },
});
const subscriptionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/customers/$customerId/subscriptions/$subscriptionId",
  validateSearch: forecastSearch,
  component: () => {
    const { customerId, subscriptionId } = subscriptionRoute.useParams();
    return (
      <SubscriptionPage
        key={`${customerId}:${subscriptionId}`}
        customerId={customerId}
        subscriptionId={subscriptionId}
      />
    );
  },
});
export const router = createRouter({
  routeTree: rootRoute.addChildren([
    entryRoute,
    importReviewRoute,
    invoicesRoute,
    signInRoute,
    customersRoute,
    customerRoute,
    invitationRoute,
    servicesRoute,
    serviceRoute,
    prepareInvoiceRoute,
    reviewInvoiceRoute,
    subscriptionsRoute,
    billingScheduleRoute,
    subscriptionRoute,
  ]),
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function SessionFeedback({
  session,
}: {
  session: ReturnType<typeof useSession>;
}) {
  if (session.isPending)
    return (
      <p className="panel state-panel" role="status">
        Checking your session…
      </p>
    );
  return (
    <section className="panel state-panel">
      <h1>Account access unavailable</h1>
      <p role="alert">{session.error?.message}</p>
      <button
        type="button"
        className="secondary-button"
        disabled={session.isFetching}
        onClick={() => void session.refetch()}
      >
        {session.isFetching ? "Trying again…" : "Retry account access"}
      </button>
    </section>
  );
}

function Entry() {
  const session = useSession();
  if (session.isPending || session.isError)
    return <SessionFeedback session={session} />;
  if (session.data === null) return <ImportReview route="/" />;
  return (
    <Navigate to={session.data.user ? "/customers" : "/sign-in"} replace />
  );
}

function StaffImportReview() {
  const session = useSession();
  const search = importReviewRoute.useSearch();
  if (session.isPending || session.isError)
    return <SessionFeedback session={session} />;
  if (session.data === null) return <Navigate to="/" search={search} replace />;
  if (!session.data.user) return <Navigate to="/sign-in" replace />;
  if (session.data.staffRoles.length === 0)
    return <Navigate to="/customers" replace />;
  return <ImportReview route="/import-review" />;
}

type Home = "import-review" | "customers" | "sign-in" | undefined;

// The anonymous viewer has no session endpoint; the portal starts at Customers.
function useHome(): Home {
  const session = useSession();
  if (session.isPending || session.isError) return undefined;
  if (session.data === null) return "import-review";
  return session.data.user ? "customers" : "sign-in";
}

function HomeLink({
  home,
  className,
  children,
}: {
  home: Home;
  className?: string;
  children: ReactNode;
}) {
  if (home === "import-review")
    return (
      <Link to="/" search={importReviewStart} className={className}>
        {children}
      </Link>
    );
  if (home === "customers")
    return (
      <Link to="/customers" className={className}>
        {children}
      </Link>
    );
  if (home === "sign-in")
    return (
      <Link to="/sign-in" className={className}>
        {children}
      </Link>
    );
  return <span className={className}>{children}</span>;
}

function NotFound() {
  const home = useHome();
  return (
    <section className="panel state-panel">
      <h1>Page not found</h1>
      {home && (
        <HomeLink home={home}>
          {home === "import-review"
            ? "Return to import review"
            : home === "customers"
              ? "Go to customers"
              : "Sign in"}
        </HomeLink>
      )}
    </section>
  );
}

function Navigation() {
  const session = useSession();
  if (session.isPending) return null;
  if (session.isError)
    return (
      <nav aria-label="Resources">
        <span role="alert">Account access unavailable.</span>
      </nav>
    );
  if (session.data === null)
    return (
      <nav aria-label="Resources">
        <Link
          to="/invoices"
          search={{ offset: 0 }}
          activeOptions={{ includeSearch: false }}
        >
          Invoices
        </Link>
        <a href="/api/openapi/json">OpenAPI</a>
      </nav>
    );
  const { user, staffRoles } = session.data;
  if (!user)
    return (
      <nav aria-label="Resources">
        <Link to="/sign-in">Sign in</Link>
      </nav>
    );
  // Navigation hints only; every page and command is authorized by the server.
  return (
    <>
      <nav aria-label="Resources">
        <Link to="/customers">Customers</Link>
        <Link
          to="/invoices"
          search={{ offset: 0 }}
          activeOptions={{ includeSearch: false }}
        >
          Invoices
        </Link>
        {staffRoles.length > 0 && (
          <Link
            to="/import-review"
            search={importReviewStart}
            activeOptions={{ exact: true, includeSearch: false }}
          >
            Import review
          </Link>
        )}
      </nav>
      <div className="site-account">
        <span>{user.name}</span>
        <SignOutButton />
      </div>
    </>
  );
}

function Shell() {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <HomeLink home={useHome()} className="brand">
          <span className="brand-mark" aria-hidden="true">
            D
          </span>
          <span>Datapad</span>
        </HomeLink>
        <Navigation />
      </header>
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
