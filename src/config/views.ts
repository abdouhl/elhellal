// View-tracking API base. Defaults to a same-origin path — set up a Cloudflare
// Worker Route mapping `elhellal.com/api/*` to the `elhellal-views` worker
// (see workers/views/) so these calls need no CORS handling at all.
//
// If you'd rather call the worker's *.workers.dev URL directly instead of
// wiring a Route, replace this with that full URL (CORS is already handled
// worker-side for elhellal.com).
export const VIEWS_API_BASE = "/api";
