// [F100 §3.2] withActionLog - thin wrapper that logs a button action after
// the handler runs. Use: <Button onClick={withActionLog({feature:"add-site",action:"save"}, onSave)} ... />
//
// The wrapper:
//   - calls the original handler with the event
//   - times the call with performance.now()
//   - captures the return value (awaits if promise) as `result`
//   - captures any thrown error as `error`
//   - writes a record via logButtonAction()
//   - re-throws so existing error semantics are preserved
//
// Params can be a static object OR a function that receives the event and
// returns the params object (useful when params depend on current state).

import { logButtonAction } from "./collectorAgent";

type Handler<E, R> = (e: E) => R | Promise<R>;

interface LogMeta {
  feature: string;
  action: string;
  params?: Record<string, unknown> | ((e: any) => Record<string, unknown>);
}

export function withActionLog<E, R>(meta: LogMeta, handler?: Handler<E, R>): Handler<E, R | undefined> {
  return async function (this: unknown, e: E) {
    const start = performance.now();
    let result: unknown;
    let error: string | undefined;
    try {
      if (handler) {
        result = await handler.call(this, e);
      }
    } catch (err) {
      error = String((err as Error)?.message || err);
      throw err;
    } finally {
      const elapsedMs = Math.round(performance.now() - start);
      const params = typeof meta.params === "function" ? (meta.params as (e: E) => Record<string, unknown>)(e) : meta.params;
      logButtonAction({
        feature: meta.feature,
        action: meta.action,
        params,
        result,
        elapsedMs,
        error,
      });
    }
    return result as R;
  };
}
