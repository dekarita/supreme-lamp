// [F91 §D.3] The per-result smart-streaming control. Rendered inside a result
// card (and the LabInspector row) when streamRouter.routeContent() says the
// URL has a media route; it returns NOTHING for generic rows, so ordinary
// results keep exactly the F84 action set (the mirror Open button).
//
//   audio-inline -> <audio controls> whose src is /api/stream?url=<X>: the
//                   bytes ride RDP -> dashboard -> user, so the provider sees
//                   the RUNNER's IP (the operator's whole point). The element
//                   carries the exact src the spec pins; a stream route that
//                   403/429s degrades to a visible "open in RDP instead" line
//                   INSIDE the player row, never a broken page.
//   video-rdp    -> "Watch in RDP" button: queueLauncherJob(navigate) AND a
//                   local tab via openMirrored - the mirror contract.
//   live-rdp     -> "Watch Live in RDP": same mirror flow, live-tuned label.
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { openMirrored } from "@/lib/launchUrl";
import { routeContent, streamSrc, type StreamRoute } from "@/lib/streamRouter";
import { useToastStore } from "@/stores/toastStore";

export interface StreamCardProps {
  url: string;
  mimeType?: string | null;
  title?: string;
  /** the sfx suffix keeps every id unique inside a virtualized row */
  suffix: string;
}

export function streamRouteFor(url: string, mimeType?: string | null): StreamRoute {
  return routeContent(url, mimeType);
}

export function StreamCard({ url, mimeType, title, suffix }: StreamCardProps) {
  const { t } = useTranslation();
  const push = useToastStore((s) => s.push);
  const route = routeContent(url, mimeType);
  const [playError, setPlayError] = useState(false);

  const watchInRdp = useCallback(async () => {
    const out = await openMirrored(url, { push, t });
    void out;
  }, [url, push, t]);

  if (!url || route === "generic") return null;

  return (
    <span
      id={"f91.search.streamCard." + suffix}
      data-testid="f91-stream-card"
      data-route={route}
      className="inline-flex items-center gap-2 min-w-0"
    >
      {route === "audio-inline" ? (
        playError ? (
          <button
            type="button"
            data-testid="f91-stream-audio-fallback"
            onClick={() => void watchInRdp()}
            className="h-8 px-2 rounded-md border border-default text-xs text-warning hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {t("mirror.audioStreamFailed")}
          </button>
        ) : (
          <audio
            data-testid="f91-stream-audio"
            aria-label={t("mirror.audioPlayLabel") + (title ? ": " + title : "")}
            controls
            preload="none"
            src={streamSrc(url)}
            onError={() => setPlayError(true)}
            className="h-9 w-64 max-w-full"
          />
        )
      ) : null}
      {route === "video-rdp" || route === "live-rdp" ? (
        <button
          id={"f91.search.streamWatch." + suffix}
          type="button"
          data-testid="f91-stream-watch-rdp"
          title={title || url}
          onClick={() => void watchInRdp()}
          className="h-8 px-2 rounded-md border border-default text-xs text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent inline-flex items-center gap-1"
        >
          {"\u25B6"} {route === "live-rdp" ? t("mirror.watchLiveInRdp") : t("mirror.watchInRdp")}
        </button>
      ) : null}
    </span>
  );
}

export default StreamCard;
