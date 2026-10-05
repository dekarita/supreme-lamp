// [F41 plan §5.1] Overview (/) - the landing route; carries ALL 219 regression
// ids via the domain components + page furniture.
import { PrimaryActions } from "@/components/domain/PrimaryActions";
// [F96 §2.2/§2.3] the one-paste diagnostic bundle + at-a-glance strip.
import { DiagBundleCard } from "@/components/domain/DiagBundleCard";
import { ConnectionCard } from "@/components/domain/ConnectionCard";
import { KeysCard } from "@/components/domain/KeysCard";
import { WebDesktopCard } from "@/components/domain/WebDesktopCard";
import { MirrorCard } from "@/components/domain/MirrorCard";
import { LogPanel } from "@/components/domain/LogPanel";
import { DiagnosticsDrawer } from "@/components/domain/DiagnosticsDrawer";
import { TelescopeTimeline } from "@/components/domain/TelescopeTimeline";
import { LauncherBeaconViewer } from "@/components/domain/LauncherBeaconViewer";
import { InstallGuide } from "@/components/domain/InstallGuide";
import { ManualVerifyDrawer } from "@/components/domain/ManualVerifyDrawer";

function SinhalaSample() {
  return (
    <p id="sinhalaSample" lang="si" className="max-w-shell mx-auto px-4 pb-6 text-xs text-tertiary">
      සිංහල සහය: මෙම පාලක පුවරුව සිංහල අකුරු නිවැරදිව පෙන්වයි (Noto Sans Sinhala අකුරු සමඟ).
    </p>
  );
}

export default function Overview() {
  return (
    <div>
      <PrimaryActions />

      {/* [F96 §2.2] FIRST thing on Overview on purpose: it is the only control
          the operator can use to hand a whole failure to Claude in one click. */}
      <DiagBundleCard />

      {/* Secondary row: Keys | Web Desktop | Mirror */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
        <KeysCard />
        <div className="flex flex-col gap-4">
          <WebDesktopCard />
        </div>
      </div>

      <ConnectionCard />
      <MirrorCard />
      <LogPanel />

      {/* Drawers: diagnostics / telescope / launcher / install / manual verify */}
      <div className="flex flex-col gap-3 mb-6">
        <DiagnosticsDrawer />
        <TelescopeTimeline />
        <LauncherBeaconViewer />
        <InstallGuide />
        <ManualVerifyDrawer />
      </div>

      <SinhalaSample />
    </div>
  );
}
