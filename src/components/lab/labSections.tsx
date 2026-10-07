// [F106 §4] The section map: registry id -> the SHIPPED page component.
//
// The lab does not re-implement a section, it mounts the real one - the whole
// point of a harness. This file is therefore deliberately thin: 11 imports and
// one Record whose keys are a FeatureId union member each, so TS fails the build
// if a section is renamed, and tests/f106-lab-routes.test.js cross-checks the
// keys against the F105 registry (a 12th section cannot appear in the registry
// without this map failing, and vice versa).
//
// WHY STATIC IMPORTS, NOT React.lazy: the dashboard ships as a SINGLE-FILE build
// (vite-plugin-singlefile inlines every chunk into ui/dist/index.html), so a lazy
// import would resolve to the same bytes after an extra round trip - split points
// that cannot split are theatre, and the F106 gate would be proving a property
// the bundler erases. The cost is honest and small: the lab route is a deep link
// (no sidebar entry by default), and every page it pulls in was already in the
// bundle for its own route.
import type { ComponentType } from "react";
import Overview from "@/pages/Overview";
import SearchPage from "@/pages/Search";
import Sessions from "@/pages/Sessions";
import Connections from "@/pages/Connections";
import Keys from "@/pages/Keys";
import FileExplorer from "@/pages/FileExplorer";
import Mirror from "@/pages/Mirror";
import Telemetry from "@/pages/Telemetry";
import HealthPage from "@/pages/Health";
import Collector from "@/pages/Collector";
import Settings from "@/pages/Settings";
import type { FeatureId } from "@/lib/featureRegistry";

export const LAB_SECTIONS: Record<FeatureId, ComponentType> = {
  overview: Overview,
  search: SearchPage,
  sessions: Sessions,
  connections: Connections,
  keys: Keys,
  files: FileExplorer,
  mirror: Mirror,
  telemetry: Telemetry,
  health: HealthPage,
  collector: Collector,
  settings: Settings,
};
