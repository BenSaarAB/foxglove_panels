import {
  Immutable,
  MessageEvent,
  PanelExtensionContext,
  SettingsTree,
  SettingsTreeAction,
  SettingsTreeNode,
} from "@foxglove/extension";
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

// ── ROS message types ─────────────────────────────────────────────────────────

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
interface CachedStatus {
  level: number;
  name: string;
  hardware_id: string;
  values: KeyValue[];
  lastSeenSec: number;
}

// ── Config ────────────────────────────────────────────────────────────────────

type ModuleMode = "diagnostics" | "heartbeat" | "diag-name" | "diag-hardware-id";

interface ModuleConfig {
  id: string;
  label: string;
  topics: string; // comma-separated, used by diagnostics/heartbeat modes
  mode: ModuleMode;
  // diag-name mode
  diagName?: string;
  valueKey?: string;
  // diag-hardware-id mode
  hardwareId?: string;
  primarySubName?: string;
  primaryKey?: string;
  primarySubLabel?: string;
  secondarySubName?: string;
  secondaryKey?: string;
  secondarySubLabel?: string;
}

interface PanelConfig {
  modules: ModuleConfig[];
  diagPrefix: string;
  freqKey: string;
  staleThresholdMs: number;
  diagCacheTimeoutSec: number;
}

const DEFAULT_CONFIG: PanelConfig = {
  modules: [
    { id: "mod0", label: "Lidar", topics: "/lidar/scan", mode: "diagnostics" },
    { id: "mod1", label: "Camera", topics: "/camera/image_raw", mode: "diagnostics" },
    { id: "mod2", label: "IMU", topics: "/imu/data", mode: "diagnostics" },
    { id: "mod3", label: "Odometry", topics: "/odometry/filtered", mode: "diagnostics" },
    { id: "mod4", label: "GPS", topics: "/gps/fix", mode: "diagnostics" },
    { id: "mod5", label: "Planner", topics: "/planner/output", mode: "diagnostics" },
  ],
  diagPrefix: "health_monitor",
  freqKey: "Frequency [hz]",
  staleThresholdMs: 5000,
  diagCacheTimeoutSec: 2.0,
};

// ── Status display ────────────────────────────────────────────────────────────

type StatusLevel = "ok" | "warn" | "error" | "stale" | "unknown";

interface ModuleState {
  status: StatusLevel;
  value: string;
  value2?: string;
}

const DEFAULT_STATE: ModuleState = { status: "unknown", value: "—" };

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

function diagLevelToStatus(level: number): StatusLevel {
  if (level === 0) return "ok";
  if (level === 1) return "warn";
  if (level === 2) return "error";
  if (level === 3) return "stale";
  return "unknown";
}

// ── Badge ─────────────────────────────────────────────────────────────────────

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

// ── Settings helpers ──────────────────────────────────────────────────────────

function buildSettingsTree(config: PanelConfig): SettingsTree["nodes"] {
  const moduleChildren: Record<string, SettingsTreeNode> = {};
  config.modules.forEach((mod) => {
    const modeFields: SettingsTreeNode["fields"] = {
      label: { label: "Label", input: "string", value: mod.label },
      mode: {
        label: "Mode",
        input: "select",
        value: mod.mode,
        options: [
          { label: "Diagnostics", value: "diagnostics" },
          { label: "Heartbeat", value: "heartbeat" },
          { label: "Diag by name", value: "diag-name" },
          { label: "Diag by hardware_id", value: "diag-hardware-id" },
        ],
      },
    };

    if (mod.mode === "diagnostics" || mod.mode === "heartbeat") {
      modeFields.topics = {
        label: "Topics (comma-separated)",
        input: "string",
        value: mod.topics,
        help:
          mod.mode === "diagnostics"
            ? 'Looked up as "<prefix>: <topic>" in /diagnostics. Multiple topics use the best (lowest) level.'
            : "Module is OK whenever any message arrives on these topics.",
      };
    }

    if (mod.mode === "diag-name") {
      modeFields.diagName = {
        label: "Diagnostic name",
        input: "string",
        value: mod.diagName ?? "",
        help: 'Exact name field of the diagnostic entry, e.g. "ram_monitor: RAM Information"',
      };
      modeFields.valueKey = {
        label: "Value key",
        input: "string",
        value: mod.valueKey ?? "",
        help: 'Key in values[] to display, e.g. "RAM Load Average"',
      };
    }

    if (mod.mode === "diag-hardware-id") {
      modeFields.hardwareId = {
        label: "hardware_id",
        input: "string",
        value: mod.hardwareId ?? "",
        help: "Filter diagnostic entries by this hardware_id. Worst level across all matches is shown.",
      };
      modeFields.primarySubName = {
        label: "Primary entry name",
        input: "string",
        value: mod.primarySubName ?? "",
        help: 'Name of the entry to read the primary value from, e.g. "lanes"',
      };
      modeFields.primaryKey = {
        label: "Primary value key",
        input: "string",
        value: mod.primaryKey ?? "",
        help: 'Key in values[] for the primary value, e.g. "delay"',
      };
      modeFields.primarySubLabel = {
        label: "Primary label prefix",
        input: "string",
        value: mod.primarySubLabel ?? "",
        help: 'Short prefix shown before the value, e.g. "L"',
      };
      modeFields.secondarySubName = {
        label: "Secondary entry name",
        input: "string",
        value: mod.secondarySubName ?? "",
      };
      modeFields.secondaryKey = {
        label: "Secondary value key",
        input: "string",
        value: mod.secondaryKey ?? "",
      };
      modeFields.secondarySubLabel = {
        label: "Secondary label prefix",
        input: "string",
        value: mod.secondarySubLabel ?? "",
      };
    }

    moduleChildren[mod.id] = {
      label: mod.label || "Module",
      actions: [{ type: "action" as const, id: `remove-${mod.id}`, label: "Remove" }],
      fields: modeFields,
    };
  });

  return {
    modules: {
      label: "Modules",
      actions: [{ type: "action" as const, id: "add-module", label: "Add module" }],
      children: moduleChildren as SettingsTree["nodes"],
    },
    diagnostics: {
      label: "Diagnostics",
      fields: {
        diagPrefix: {
          label: "Name prefix",
          input: "string",
          value: config.diagPrefix,
          help: 'Matched against diagnostic entry names. e.g. "health_monitor" matches "health_monitor: /my/topic"',
        },
        freqKey: {
          label: "Frequency key",
          input: "string",
          value: config.freqKey,
          help: "Key in the diagnostic values[] array that holds the publishing rate",
        },
        diagCacheTimeoutSec: {
          label: "Cache timeout (s)",
          input: "number",
          value: config.diagCacheTimeoutSec,
          min: 0.1,
          step: 0.1,
        },
      },
    },
    display: {
      label: "Display",
      fields: {
        staleThresholdMs: {
          label: "Stale threshold (ms)",
          input: "number",
          value: config.staleThresholdMs,
          min: 100,
          step: 100,
          help: "How long after the last message before a module is marked stale",
        },
      },
    },
  };
}

function applyUpdate(config: PanelConfig, path: readonly string[], value: unknown): PanelConfig {
  if (path[0] === "modules" && path.length === 3) {
    const modId = path[1]!;
    const field = path[2] as keyof ModuleConfig;
    return {
      ...config,
      modules: config.modules.map((m) => (m.id === modId ? { ...m, [field]: value } : m)),
    };
  }
  if ((path[0] === "diagnostics" || path[0] === "display") && path.length === 2) {
    return { ...config, [path[1]!]: value };
  }
  return config;
}

function applyAction(config: PanelConfig, id: string): PanelConfig {
  if (id === "add-module") {
    return {
      ...config,
      modules: [
        ...config.modules,
        { id: `mod${Date.now()}`, label: "New Module", topics: "", mode: "diagnostics" },
      ],
    };
  }
  if (id.startsWith("remove-")) {
    const modId = id.slice("remove-".length);
    return { ...config, modules: config.modules.filter((m) => m.id !== modId) };
  }
  return config;
}

// ── Panel ─────────────────────────────────────────────────────────────────────

function SystemHealthPanel({ context }: { context: PanelExtensionContext }): ReactElement {
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const [moduleStates, setModuleStates] = useState<Record<string, ModuleState>>({});
  const [scale, setScale] = useState(1);
  const [config, setConfig] = useState<PanelConfig>(() => {
    const saved = context.initialState as Partial<PanelConfig> | undefined;
    if (!saved?.modules) return DEFAULT_CONFIG;
    return { ...DEFAULT_CONFIG, ...saved };
  });

  const stateRef = useRef<Record<string, ModuleState>>({});
  const diagCacheRef = useRef<Map<string, CachedStatus>>(new Map());
  const lastSeenRef = useRef<Record<string, number>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  // Settings editor — rebuilt on every config change
  useEffect(() => {
    context.updatePanelSettingsEditor({
      actionHandler: (action: SettingsTreeAction) => {
        if (action.action === "update") {
          setConfig((prev) => applyUpdate(prev, action.payload.path, action.payload.value));
        } else if (action.action === "perform-node-action") {
          setConfig((prev) => applyAction(prev, action.payload.id));
        }
      },
      nodes: buildSettingsTree(config),
    });
  }, [config, context]);

  // Persist config across sessions
  useEffect(() => {
    context.saveState(config);
  }, [config, context]);

  // Subscribe to /diagnostics always; add heartbeat topics dynamically
  useEffect(() => {
    const topics = new Set(["/diagnostics"]);
    for (const mod of config.modules) {
      if (mod.mode === "heartbeat") {
        for (const t of mod.topics
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)) {
          topics.add(t);
        }
      }
    }
    context.subscribe([...topics].map((topic) => ({ topic })));
  }, [config, context]);

  // Resize observer for badge scale
  const updateScale = useCallback((width: number, height: number) => {
    const n = configRef.current.modules.length;
    const usableW = width - 12;
    const usableH = height - 22;
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
      const cfg = configRef.current;
      const frame = renderState.currentFrame as Immutable<MessageEvent[]> | undefined;
      if (!frame?.length) {
        done();
        return;
      }

      const now = Date.now();
      const heartbeats = lastSeenRef.current;
      let changed = false;
      const s = { ...stateRef.current };

      const patch = (label: string, update: Partial<ModuleState>) => {
        const prev = s[label] ?? DEFAULT_STATE;
        const visibleChange =
          (update.status !== undefined && update.status !== prev.status) ||
          (update.value !== undefined && update.value !== prev.value);
        if (visibleChange) {
          s[label] = { ...prev, ...update };
          changed = true;
        }
      };

      for (const event of frame) {
        // ── Diagnostics ───────────────────────────────────────────────────────
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
            if (nowSec - entry.lastSeenSec > cfg.diagCacheTimeoutSec) cache.delete(key);
          }

          // ── diag-name mode ────────────────────────────────────────────────
          for (const mod of cfg.modules) {
            if (mod.mode !== "diag-name" || !mod.diagName) continue;
            const entry = cache.get(mod.diagName);
            if (entry != null) {
              heartbeats[mod.label] = now;
              const update: Partial<ModuleState> = { status: diagLevelToStatus(entry.level) };
              if (mod.valueKey) {
                const raw = entry.values.find((v) => v.key === mod.valueKey)?.value;
                if (raw != null) update.value = raw;
              }
              patch(mod.label, update);
            }
          }

          // ── diag-hardware-id mode ─────────────────────────────────────────
          for (const mod of cfg.modules) {
            if (mod.mode !== "diag-hardware-id" || !mod.hardwareId) continue;
            let worstLevel = -1;
            let primaryVal: string | undefined;
            let secondaryVal: string | undefined;
            let seen = false;

            for (const entry of cache.values()) {
              if (entry.hardware_id !== mod.hardwareId) continue;
              seen = true;
              if (entry.level > worstLevel) worstLevel = entry.level;
              if (mod.primarySubName && entry.name === mod.primarySubName && mod.primaryKey) {
                primaryVal = entry.values.find((v) => v.key === mod.primaryKey)?.value;
              }
              if (mod.secondarySubName && entry.name === mod.secondarySubName && mod.secondaryKey) {
                secondaryVal = entry.values.find((v) => v.key === mod.secondaryKey)?.value;
              }
            }

            if (seen) {
              heartbeats[mod.label] = now;
              const update: Partial<ModuleState> = { status: diagLevelToStatus(worstLevel) };
              if (primaryVal != null)
                update.value = mod.primarySubLabel ? `${mod.primarySubLabel}: ${primaryVal}` : primaryVal;
              if (secondaryVal != null)
                update.value2 = mod.secondarySubLabel
                  ? `${mod.secondarySubLabel}: ${secondaryVal}`
                  : secondaryVal;
              patch(mod.label, update);
            }
          }

          // ── diagnostics mode ──────────────────────────────────────────────
          for (const mod of cfg.modules) {
            if (mod.mode !== "diagnostics") continue;
            const topicList = mod.topics
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean);

            let best: CachedStatus | undefined;
            let bestHz = NaN;

            for (const topic of topicList) {
              const entry = cache.get(`${cfg.diagPrefix}: ${topic}`);
              if (entry != null) {
                if (best == null || entry.level < best.level) best = entry;
                const raw = entry.values.find((v) => v.key === cfg.freqKey)?.value;
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
        }

        // ── Heartbeat ─────────────────────────────────────────────────────────
        for (const mod of cfg.modules) {
          if (mod.mode !== "heartbeat") continue;
          const topicList = mod.topics
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
          if (topicList.includes(event.topic)) {
            heartbeats[mod.label] = now;
            patch(mod.label, { status: "ok", value: "active" });
          }
        }
      }

      // Mark stale
      for (const mod of cfg.modules) {
        const lastSeen = heartbeats[mod.label] ?? 0;
        if (lastSeen > 0 && now - lastSeen > cfg.staleThresholdMs) {
          const m = s[mod.label];
          if (m && m.status !== "stale") {
            s[mod.label] = { ...m, status: "stale" };
            changed = true;
          }
        }
      }

      if (changed) {
        stateRef.current = s;
        setModuleStates(s);
        setRenderDone(() => done);
      } else {
        done();
      }
    };

    context.watch("currentFrame");
  }, [context]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  const states = useMemo(
    () => config.modules.map((mod) => ({ label: mod.label, state: moduleStates[mod.label] ?? DEFAULT_STATE })),
    [config.modules, moduleStates],
  );

  const { summary, healthyCount } = useMemo(() => {
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
          {healthyCount}/{states.length}
        </span>
      </div>

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
