// [R-GLASS / #213 §8] The one decorative backdrop layer.
//
// PRIVACY: this is a CSS gradient field and nothing else. It must never become
// a screenshot of the operator's desktop, a file thumbnail or a DVR frame —
// every one of those can carry secrets (WP-13b). There is no <img>, no canvas
// capture and no network fetch in this component by design.
//
// It is `position: fixed` + `aria-hidden` + `pointer-events: none`, painted at
// z-index 0 so every glass surface above it has something to sample. Opaque
// mode hides it entirely (globals.css), so an operator who chooses solid
// surfaces pays nothing for it.
import { useVisualQuality } from "@/lib/glass/useVisualQuality";

export function AppBackdrop() {
  const { resolved } = useVisualQuality();
  if (resolved === "opaque") return null;
  return <div className="app-backdrop" aria-hidden="true" data-testid="app-backdrop" />;
}

export default AppBackdrop;
