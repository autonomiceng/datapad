# Serve a React SPA and API from one origin

React with TanStack Router and Query provides client navigation and server-state caching for the import-review viewer, with Bun serving built assets and Vite proxying `/api` during development. One origin keeps fetch URLs and browser security policy simple; separate frontend hosting or server rendering would add deployment and contract choices that this slice does not need. The SPA pays an initial JavaScript cost and needs a client-route fallback that excludes API paths; access to real data requires application authentication and authorization.
