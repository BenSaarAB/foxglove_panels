# System Health

A [Foxglove](https://foxglove.dev) panel that displays a compact, auto-scaling grid of colored status badges for monitoring the health of system submodules in real time.

![Status badge grid showing OK, WARN, ERROR, and STALE states](https://raw.githubusercontent.com/BenSaarAB/foxglove_panels/main/system-health/docs/screenshot.png)

## Features

- **Configurable modules** — define any number of modules, each watching one or more ROS topics
- **Two monitoring modes per module:**
  - **Diagnostics** — reads OK/WARN/ERROR/STALE levels and publishing rate from `diagnostic_msgs/DiagnosticArray`, compatible with `health_monitor`, `diagnostic_aggregator`, and similar nodes
  - **Heartbeat** — marks a module OK whenever any message arrives on the topic; no diagnostic node required
- **Auto-scaling badges** — the grid fills the available panel area at any size
- **Stale detection** — modules that stop publishing turn grey automatically
- **Error pulse animation** — ERROR-state badges pulse to draw attention
- **Persistent settings** — configuration is saved per-panel layout

## Configuration

Open the panel settings (gear icon) to configure:

### Modules

Add, remove, and reorder modules. Each module has:

| Field | Description |
|---|---|
| Label | Short display name shown on the badge |
| Topics | Comma-separated ROS topic name(s). For diagnostics mode, multiple topics show the best (lowest severity) status. |
| Mode | `Diagnostics` or `Heartbeat` (see below) |

### Diagnostics mode

The panel subscribes to `/diagnostics` and looks for entries named `<prefix>: <topic>`, e.g.:

```
health_monitor: /lidar/scan   →  level=OK, Frequency [hz]=15.0
```

Settings:

| Setting | Default | Description |
|---|---|---|
| Name prefix | `health_monitor` | Prefix matched against diagnostic entry names |
| Frequency key | `Frequency [hz]` | Key in `values[]` that contains the publishing rate |
| Cache timeout (s) | `2.0` | How long to keep a diagnostic entry before pruning it |

This is compatible with any node that publishes `diagnostic_msgs/DiagnosticArray` entries in `<prefix>: <topic>` format, including [health_monitor](https://github.com/ros/diagnostics) and custom aggregators.

### Heartbeat mode

The panel subscribes directly to the topic and marks the module OK on every message. No diagnostic node is needed. The module turns stale if no message arrives within the stale threshold.

### Display

| Setting | Default | Description |
|---|---|---|
| Stale threshold (ms) | `5000` | Time after the last message before a module is marked stale |

## Badge colors

| Color | Meaning |
|---|---|
| Green | OK |
| Yellow | WARN |
| Red (pulsing) | ERROR |
| Grey | STALE or no data since last message |
| Dark grey | UNKNOWN (not yet seen) |

## Development

```sh
npm install
npm run local-install   # build and install into local Foxglove desktop
```

## Package

```sh
npm run package         # produces bensaar.system-health-<version>.foxe
```
