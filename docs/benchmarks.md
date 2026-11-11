# Goal Guardian benchmarks

> **Historical record.** This file describes earlier versions of Goal Guardian and has not been updated. It names tools that no longer exist (`guardian_get_contract`, `guardian_get_status`, `guardian_report_goal`, `guardian_update_goal` and others); the current ones are `get_goal`, `create_goal`, `update_goal`, `goal_command` and `guardian_change_goal`. For the current design see `docs/goal-design.md`.

Date: 2026-08-26T02:54:24.656Z · Node v20.20.0 · AMD Ryzen 7 3800X 8-Core Processor (16 cores)

## 1. Hook latency (packaged bin, spawn-to-response)

- bare `node -e 0` baseline: p50 27.7ms · p95 36.3ms · p99 37.8ms (n=30)
- neutral shell: p50 65.4ms · p95 77.5ms · p99 84.0ms (n=60)

## 2. MCP tool round-trips (packaged server, real stdio)

- cold start + handshake: 123.0ms
- guardian_get_contract: p50 1.7ms · p95 2.9ms · p99 7.7ms (n=50)
- guardian_get_status: p50 2.0ms · p95 2.8ms · p99 4.1ms (n=50)
