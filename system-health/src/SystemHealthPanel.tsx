import { Immutable, MessageEvent, PanelExtensionContext } from "@foxglove/extension";
import {
  memo,
  ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";

// diagnostic_msgs/DiagnosticArray
interface KeyValue {
  key: string;
  value: string;
}
interface DiagnosticStatus {
  level: number; // 0=OK 1=WARN 2=ERROR 3=STALE
  name: string;
  hardware_id: string;
  values: KeyValue[];
}
interface DiagnosticArray {
  status: DiagnosticStatus[];
}

// Internal aggregation cache — replicates the /script/diagnostics_aggregated user script.
// Entries from /diagnostics are stored by name and pruned after DIAG_CACHE_TIMEOUT_SEC.
interface CachedStatus {
  level: number;
  name: string;
  hardware_id: string;
  values: KeyValue[];
  lastSeenSec: number;
}

const DIAG_CACHE_TIMEOUT_SEC = 2.0;

// sensor_msgs/NavSatFix
interface NavSatFix {
  status: { status: number }; // -1=NO_FIX, 0=FIX, 1=SBAS_FIX, 2=GBAS_FIX
}

type StatusLevel = "ok" | "warn" | "error" | "stale" | "unknown";

// Visible state only — fields here are what the badge renders. Keeping
// heartbeat (lastSeenMs) out of this struct lets us avoid re-creating state
// objects when only a heartbeat ticked, which preserves React.memo equality.
interface ModuleState {
  status: StatusLevel;
  value: string;
  value2?: string;
}

const DEFAULT_STATE: ModuleState = { status: "unknown", value: "—" };

const HEALTH_MONITOR_MODULES = [
  { label: "Twist", topics: ["/vehicle/twist"] },
  { label: "Accel", topics: ["/vehicle/accel"] },
  { label: "OD", topics: ["/hardware_interface_results_360/frame_results"] },
  { label: "TF", topics: ["/tf"] },
  { label: "GPS", topics: ["/vehicle/gps/fix"] },
  { label: "A2R", topics: ["/l2pp/a2r/fusion_result"] },
  { label: "GP", topics: ["/global_planner_output"] },
  { label: "BP", topics: ["/behavioral_planner_output"] },
  { label: "LP", topics: ["/agents/trajectory", "/ab/trajectory"] },
];

const ALL_MODULE_LABELS = [
  ...HEALTH_MONITOR_MODULES.map((m) => m.label),
  "Odom",
  "RAM",
];

const STALE_THRESHOLD_MS = 5000;

function diagLevelToStatus(level: number): StatusLevel {
  if (level === 0) return "ok";
  if (level === 1) return "warn";
  if (level === 2) return "error";
  if (level === 3) return "stale";
  return "unknown";
}

function ramPctToStatus(pct: number): StatusLevel {
  if (pct > 85) return "error";
  if (pct > 70) return "warn";
  return "ok";
}

const STATUS_COLOR: Record<StatusLevel, string> = {
  ok: "#22c55e",
  warn: "#f59e0b",
  error: "#ef4444",
  stale: "#6b7280",
  unknown: "#4b5563",
};

const STATUS_BG: Record<StatusLevel, string> = {
  ok: "rgba(34,197,94,0.18)",
  warn: "rgba(245,158,11,0.20)",
  error: "rgba(239,68,68,0.22)",
  stale: "rgba(107,114,128,0.15)",
  unknown: "rgba(75,85,99,0.12)",
};

const STATUS_LABEL_COLOR: Record<StatusLevel, string> = {
  ok: "#a3f0bc",
  warn: "#fde68a",
  error: "#fca5a5",
  stale: "#9ca3af",
  unknown: "#9ca3af",
};

const PULSE_STYLE = `
  @keyframes hm-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }
  .hm-error { animation: hm-pulse 1.6s ease-in-out infinite; }
`;

const Badge = memo(function Badge({
  label,
  state,
  scale,
}: {
  label: string;
  state: ModuleState;
  scale: number;
}): ReactElement {
  const color = STATUS_COLOR[state.status];
  const isError = state.status === "error";
  const fs = (base: number) => `${(base * scale).toFixed(1)}px`;
  return (
    <div
      className={isError ? "hm-error" : undefined}
      style={{
        background: STATUS_BG[state.status],
        border: `1px solid ${color}44`,
        borderLeft: `${Math.max(2, Math.round(4 * scale))}px solid ${color}`,
        borderRadius: `${Math.round(5 * scale)}px`,
        padding: `${(5 * scale).toFixed(1)}px ${(8 * scale).toFixed(1)}px`,
        display: "flex",
        flexDirection: "column",
        gap: `${(2 * scale).toFixed(1)}px`,
        justifyContent: "center",
        minHeight: `${(38 * scale).toFixed(1)}px`,
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <span
        style={{
          fontSize: fs(11),
          fontWeight: 700,
          color: STATUS_LABEL_COLOR[state.status],
          letterSpacing: "0.15px",
          lineHeight: 1,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: fs(10), color: "#888", lineHeight: 1 }}>{state.value}</span>
      {state.value2 != null && (
        <span style={{ fontSize: fs(10), color: "#888", lineHeight: 1 }}>{state.value2}</span>
      )}
    </div>
  );
});

function SystemHealthPanel({ context }: { context: PanelExtensionContext }): ReactElement {
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const [moduleStates, setModuleStates] = useState<Record<string, ModuleState>>({});
  const [scale, setScale] = useState(1);
  const stateRef = useRef<Record<string, ModuleState>>({});
  const diagCacheRef = useRef<Map<string, CachedStatus>>(new Map());
  const lastSeenRef = useRef<Record<string, number>>({});
  const containerRef = useRef<HTMLDivElement>(null);

  // Compute font scale so badges always fill the available area
  const updateScale = useCallback((width: number, height: number) => {
    const usableW = width - 12;
    const usableH = height - 22; // approximate header height
    const n = ALL_MODULE_LABELS.length;
    const cols = Math.max(1, Math.floor((usableW + 4) / (72 + 4)));
    const rows = Math.max(1, Math.ceil(n / cols));
    const badgeW = usableW / cols - 4;
    const badgeH = usableH / rows - 4;
    const newScale = Math.max(0.7, Math.min(2.5, Math.min(badgeW / 72, badgeH / 38)));
    setScale((prev) => (Math.abs(prev - newScale) < 0.001 ? prev : newScale));
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) updateScale(entry.contentRect.width, entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateScale]);

  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      const frame = renderState.currentFrame as Immutable<MessageEvent[]> | undefined;
      if (!frame?.length) {
        done();
        return;
      }

      const now = Date.now();
      const heartbeats = lastSeenRef.current;
      let changed = false;
      const s = { ...stateRef.current };

      // Patch only fires a re-render when a *visible* field actually differs.
      // Heartbeat (lastSeenRef) is always recorded by callers via seen() — kept
      // separate so a steady-state diagnostic stream doesn't churn React state.
      const patch = (label: string, update: Partial<ModuleState>) => {
        const prev = s[label] ?? DEFAULT_STATE;
        const visibleChange =
          (update.status !== undefined && update.status !== prev.status) ||
          (update.value !== undefined && update.value !== prev.value) ||
          (update.value2 !== undefined && update.value2 !== prev.value2);
        if (visibleChange) {
          s[label] = { ...prev, ...update };
          changed = true;
        }
      };

      for (const event of frame) {
        // ── /diagnostics ─────────────────────────────────────────────────────
        // Replicates /script/diagnostics_aggregated inline: all entries are cached
        // by name and pruned after DIAG_CACHE_TIMEOUT_SEC, so the panel is
        // self-contained and needs no external user script.
        if (event.topic === "/diagnostics") {
          const msg = event.message as DiagnosticArray;
          const nowSec = now / 1000;
          const cache = diagCacheRef.current;

          for (const st of msg.status) {
            if (typeof st?.name === "string" && st.name !== "") {
              cache.set(st.name, {
                level: st.level ?? 0,
                name: st.name,
                hardware_id: st.hardware_id ?? "",
                values: Array.isArray(st.values) ? st.values : [],
                lastSeenSec: nowSec,
              });
            }
          }

          for (const [key, entry] of cache) {
            if (nowSec - entry.lastSeenSec > DIAG_CACHE_TIMEOUT_SEC) cache.delete(key);
          }

          // Health monitor: best (lowest) level + highest Hz across candidate topics
          for (const mod of HEALTH_MONITOR_MODULES) {
            let best: CachedStatus | undefined;
            let bestHz = NaN;
            for (const topic of mod.topics) {
              const entry = cache.get(`health_monitor: ${topic}`);
              if (entry != null) {
                if (best == null || entry.level < best.level) best = entry;
                const raw = entry.values.find((v) => v.key === "Frequency [hz]")?.value;
                const parsed = raw != null ? parseFloat(raw) : NaN;
                if (!isNaN(parsed) && (isNaN(bestHz) || parsed > bestHz)) bestHz = parsed;
              }
            }
            if (best != null) {
              heartbeats[mod.label] = now;
              const update: Partial<ModuleState> = { status: diagLevelToStatus(best.level) };
              if (!isNaN(bestHz)) update.value = `${bestHz.toFixed(1)} Hz`;
              patch(mod.label, update);
            }
          }

          // RAM — match by name only; hardware_id varies per machine
          const ram = cache.get("ram_monitor: RAM Information");
          if (ram) {
            const raw = ram.values.find((v) => v.key === "RAM Load Average")?.value;
            const pct = raw != null ? parseFloat(raw) : NaN;
            heartbeats.RAM = now;
            patch("RAM", {
              status: isNaN(pct) ? "unknown" : ramPctToStatus(pct),
              value: isNaN(pct) ? "—" : `${pct.toFixed(0)}%`,
            });
          }

          // Odom — single pass over cache: collect worst level + delay strings
          let odomSeen = false;
          let odomWorstLevel = 0;
          let lanesDelay: string | undefined;
          let predsDelay: string | undefined;
          for (const e of cache.values()) {
            if (e.hardware_id !== "odometry_correction") continue;
            odomSeen = true;
            if (e.level > odomWorstLevel) odomWorstLevel = e.level;
            if (e.name === "lanes") {
              lanesDelay = e.values.find((v) => v.key === "delay")?.value;
            } else if (e.name === "predictions") {
              predsDelay = e.values.find((v) => v.key === "delay")?.value;
            }
          }
          if (odomSeen) {
            heartbeats.Odom = now;
            patch("Odom", { status: diagLevelToStatus(odomWorstLevel) });
            if (lanesDelay != null) patch("Odom", { value: `L: ${lanesDelay}` });
            if (predsDelay != null) patch("Odom", { value2: `P: ${predsDelay}` });
          }
        }

        // ── /vehicle/gps/fix ─────────────────────────────────────────────────
        if (event.topic === "/vehicle/gps/fix") {
          const msg = event.message as NavSatFix;
          const fixStatus = msg.status?.status ?? -1;
          const fixLabel =
            fixStatus === 0
              ? "GPS Fix"
              : fixStatus === 1
                ? "DGNSS Fix"
                : fixStatus === 2
                  ? "RTK Fix"
                  : "No Fix";
          // Fix type goes on second line; Hz (value) is preserved from /diagnostics
          heartbeats.GPS = now;
          patch("GPS", { value2: fixLabel });
        }
      }

      // Mark stale modules that stopped publishing
      for (const label of ALL_MODULE_LABELS) {
        const lastSeen = heartbeats[label] ?? 0;
        if (lastSeen > 0 && now - lastSeen > STALE_THRESHOLD_MS) {
          const m = s[label];
          if (m && m.status !== "stale") {
            s[label] = { ...m, status: "stale" };
            changed = true;
          }
        }
      }

      if (changed) {
        stateRef.current = s;
        setModuleStates(s);
        // Defer done() until after React commits, so Foxglove waits for paint.
        setRenderDone(() => done);
      } else {
        // No visible change — signal done immediately and skip the React round-trip.
        done();
      }
    };

    context.watch("currentFrame");
    context.subscribe([{ topic: "/diagnostics" }, { topic: "/vehicle/gps/fix" }]);
  }, [context]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  const states = useMemo(
    () =>
      ALL_MODULE_LABELS.map((label) => ({
        label,
        state: moduleStates[label] ?? DEFAULT_STATE,
      })),
    [moduleStates],
  );

  const { summary, healthyCount } = useMemo(() => {
    // Single pass replacing per-render some/every/filter chains.
    // Severity ranks must mirror the original: error > warn > stale > unknown,
    // with "ok" only when every module is OK.
    let worst: StatusLevel | undefined;
    let healthy = 0;
    let allOk = true;
    for (const { state } of states) {
      if (state.status === "ok") {
        healthy++;
        continue;
      }
      allOk = false;
      if (state.status === "error") worst = "error";
      else if (state.status === "warn" && worst !== "error") worst = "warn";
      else if (state.status === "stale" && worst !== "error" && worst !== "warn") worst = "stale";
    }
    const overall: StatusLevel =
      states.length === 0 ? "unknown" : allOk ? "ok" : (worst ?? "unknown");
    return { summary: overall, healthyCount: healthy };
  }, [states]);
  const summaryColor = STATUS_COLOR[summary];

  const fs = (base: number) => `${(base * scale).toFixed(1)}px`;

  return (
    <div
      ref={containerRef}
      style={{
        height: "100%",
        background: "#141414",
        fontFamily: "'Inter', 'SF Pro Display', system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        padding: "6px",
        gap: "5px",
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <style>{PULSE_STYLE}</style>

      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
          padding: "0 2px",
        }}
      >
        <span
          style={{
            fontSize: fs(9),
            fontWeight: 700,
            letterSpacing: "1.4px",
            color: "#555",
            textTransform: "uppercase",
          }}
        >
          System Health
        </span>
        <span
          style={{
            fontSize: fs(11),
            fontWeight: 700,
            color: summaryColor,
            letterSpacing: "0.3px",
          }}
        >
          {healthyCount}/{ALL_MODULE_LABELS.length}
        </span>
      </div>

      {/* Badge grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(auto-fill, minmax(${(72 * scale).toFixed(1)}px, 1fr))`,
          gap: `${(4 * scale).toFixed(1)}px`,
          flex: 1,
          alignContent: "start",
        }}
      >
        {states.map(({ label, state }) => (
          <Badge key={label} label={label} state={state} scale={scale} />
        ))}
      </div>
    </div>
  );
}

export function initSystemHealthPanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<SystemHealthPanel context={context} />);
  return () => {
    root.unmount();
  };
}
