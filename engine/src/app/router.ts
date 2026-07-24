/** Request router — the platform-agnostic analog of api.py's FastAPI route table.
 *
 * `handle(ctx, method, path, body)` dispatches a `METHOD /api/...` call to the
 * matching service function, exactly as FastAPI routed it. This is the single
 * seam the UI talks to: the front-end's `api.get('/api/holdings')` becomes
 * `handle(ctx, 'GET', '/api/holdings')`, so the vanilla-JS UI is unchanged except
 * for swapping `fetch` for this call. The Tauri bootstrap wires the same function.
 */

import * as svc from "./service.ts";
import type { AppContext } from "./service.ts";

export interface RouteResult {
  status: number;
  body: unknown;
}

class RouteError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Split "/api/x?y=z" into pathname + query params. */
function parse(path: string): { name: string; query: URLSearchParams } {
  const q = path.indexOf("?");
  if (q === -1) return { name: strip(path), query: new URLSearchParams() };
  return { name: strip(path.slice(0, q)), query: new URLSearchParams(path.slice(q + 1)) };
}
const strip = (p: string) => p.replace(/\/+$/, "") || "/";

/** Dispatch one request. Returns { status, body }; never throws for handled
 * routes — service NotFound/BadRequest become 404/400, anything else 500. */
export async function handle(
  ctx: AppContext, method: string, path: string, body?: unknown,
): Promise<RouteResult> {
  const m = method.toUpperCase();
  const { name, query } = parse(path);
  try {
    const out = await dispatch(ctx, m, name, query, body);
    return { status: 200, body: out };
  } catch (e) {
    const status = e instanceof RouteError ? e.status
      : (typeof (e as { status?: number })?.status === "number" ? (e as { status: number }).status : 500);
    return { status, body: { detail: e instanceof Error ? e.message : String(e) } };
  }
}

async function dispatch(
  ctx: AppContext, m: string, name: string, query: URLSearchParams, body: unknown,
): Promise<unknown> {
  // /api/history/{id}
  const hist = name.match(/^\/api\/history\/(\d+)$/);
  if (hist && m === "GET") return svc.getHistoryItem(ctx, Number(hist[1]));

  // /api/schedules/{id}/run  and  /api/schedules/{id}
  const runM = name.match(/^\/api\/schedules\/([^/]+)\/run$/);
  if (runM && m === "POST") return svc.runSchedule(ctx, decodeURIComponent(runM[1]));
  const schedId = name.match(/^\/api\/schedules\/([^/]+)$/);
  if (schedId && m === "DELETE") return svc.deleteSchedule(ctx, decodeURIComponent(schedId[1]));

  switch (`${m} ${name}`) {
    case "GET /api/status": return svc.getStatus(ctx);
    case "GET /api/holdings": return svc.getHoldings(ctx);
    case "PUT /api/holdings": return svc.putHoldings(ctx, body as svc.HoldingIn[]);
    case "GET /api/plan": return svc.getPlan(ctx);
    case "PUT /api/plan": return svc.putPlan(ctx, body as svc.PlanIn);
    case "GET /api/settings": return svc.getSettings(ctx);
    case "PUT /api/settings": return svc.putSettings(ctx, (body ?? {}) as Record<string, unknown>);
    case "GET /api/structure": return svc.getStructure(ctx);
    case "GET /api/digest": return svc.getDigest(ctx, {
      deliver: query.get("deliver") === "true",
      focus: query.get("focus") ?? "all",
      complexity: query.get("complexity") ?? "standard",
    });
    case "GET /api/history": return svc.getHistory(ctx);
    case "GET /api/sources": return svc.getSources(ctx);
    case "PUT /api/sources": return svc.putSources(ctx, body as svc.SourceIn[]);
    case "GET /api/schedules": return svc.getSchedules(ctx);
    case "PUT /api/schedules":
      return svc.putSchedule(ctx, (body ?? {}) as Parameters<typeof svc.putSchedule>[1]);
    case "POST /api/schedules/sync": return svc.syncSchedules(ctx);
    case "GET /api/open": return svc.openUrl(ctx, query.get("url") ?? "");
    case "POST /api/test-email": return svc.testEmail(ctx);
    default:
      throw new RouteError(404, `No route for ${m} ${name}`);
  }
}
