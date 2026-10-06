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

import { instrumentButton } from "./collectorAgent";

type Handler<E, R> = (e: E) => R | Promise<R>;

interface LogMeta {
  feature: string;
  action: string;
  params?: Record<string, unknown> | ((e: any) => Record<string, unknown>);
}

export function withActionLog<E, R>(meta: LogMeta, handler?: Handler<E, R>): Handler<E, R | undefined> {
  return async function (this: unknown, e: E) {
    const params = typeof meta.params === "function" ? (meta.params as (e: E) => Record<string, unknown>)(e) : meta.params;
    // [F101 §3.2] This is now the DEEP wrapper: the same signature the F100
    // call sites were written against, but the record it writes carries
    // preCheck / request / response / postCheck / serviceDependencies / verdict
    // instead of just {feature, action, params, result}. The re-throw contract
    // is preserved so existing error semantics do not change.
    const out = await instrumentButton(meta.feature, meta.action, async () => {
      if (!handler) return undefined as R | undefined;
      return await handler.call(this, e);
    }, { params });
    if (out.error) throw new Error(out.error);
    return out.result as R | undefined;
  };
}
