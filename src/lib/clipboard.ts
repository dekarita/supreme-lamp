// [F41 plan §4.11 / §3] Clipboard = navigator.clipboard + toast, with the F27
// rule intact: secret copy payloads come ONLY from the authenticated config
// state held in the session store, never from the DOM.

export type ToastKind = "ok" | "warn" | "bad" | "";

export type ToastFn = (msg: string, kind?: ToastKind) => void;

let toastFn: ToastFn = () => {};
export function registerToasts(fn: ToastFn): void {
  toastFn = fn;
}

function legacyCopy(text: string, onDone: (ok: boolean) => void): void {
  let ok = false;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "readonly");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ok = document.execCommand("copy");
    document.body.removeChild(ta);
  } catch {
    ok = false;
  }
  onDone(ok);
}

export async function copyText(text: string, label?: string): Promise<boolean> {
  const value = String(text || "");
  if (!value) {
    toastFn(label ? label + ": nothing to copy" : "Nothing to copy", "warn");
    return false;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      toastFn("Copied", "ok");
      return true;
    } catch {
      /* fall through to legacy */
    }
  }
  return new Promise<boolean>((resolve) => {
    legacyCopy(value, (ok) => {
      if (ok) toastFn("Copied", "ok");
      else {
        window.prompt("Clipboard blocked - copy with Ctrl+C:", value);
        toastFn("Copy fallback opened", "warn");
      }
      resolve(ok);
    });
  });
}
