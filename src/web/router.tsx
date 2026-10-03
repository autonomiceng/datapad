import { PaginationSchema } from "../import-review/contract";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
} from "@tanstack/react-router";
import { ImportReview } from "./import-review/viewer";

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

function offset(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isInteger(number) &&
    number >= 0 &&
    number <= PaginationSchema.properties.offset.maximum!
    ? number
    : 0;
}

const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: () => (
    <section className="panel state-panel">
      <h1>Page not found</h1>
      <Link
        to="/"
        search={{
          sourcesOffset: 0,
          importsOffset: 0,
          customersOffset: 0,
          detailsOffset: 0,
          dataIssuesOffset: 0,
        }}
      >
        Return to import review
      </Link>
    </section>
  ),
});

const importReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown>): ImportReviewSearch => ({
    sourceId: typeof search.sourceId === "string" ? search.sourceId : undefined,
    importId: typeof search.importId === "string" ? search.importId : undefined,
    customerId:
      typeof search.customerId === "string" ? search.customerId : undefined,
    sourcesOffset: offset(search.sourcesOffset),
    importsOffset: offset(search.importsOffset),
    customersOffset: offset(search.customersOffset),
    detailsOffset: offset(search.detailsOffset),
    dataIssuesOffset: offset(search.dataIssuesOffset),
  }),
  component: ImportReview,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([importReviewRoute]),
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function Shell() {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <Link
          to="/"
          search={{
            sourcesOffset: 0,
            importsOffset: 0,
            customersOffset: 0,
            detailsOffset: 0,
            dataIssuesOffset: 0,
          }}
          className="brand"
          aria-label="Datapad home"
        >
          <span className="brand-mark" aria-hidden="true">
            D
          </span>
          <span>Datapad</span>
        </Link>
        <nav aria-label="Resources">
          <a href="/api/openapi/json">OpenAPI</a>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
