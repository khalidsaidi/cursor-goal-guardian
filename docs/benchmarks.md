# Goal Guardian benchmarks

Date: 2026-08-26T02:54:24.656Z · Node v20.20.0 · AMD Ryzen 7 3800X 8-Core Processor (16 cores)

## 1. Hook latency (packaged bin, spawn-to-response)

- bare `node -e 0` baseline: p50 27.7ms · p95 36.3ms · p99 37.8ms (n=30)
- silent allow (in-scope read): p50 63.7ms · p95 71.5ms · p99 84.5ms (n=60)
- neutral shell: p50 65.4ms · p95 77.5ms · p99 84.0ms (n=60)
- drift path (episode + record): p50 70.9ms · p95 76.6ms · p99 87.4ms (n=60)
- alert path (policy + nudge): p50 62.4ms · p95 70.8ms · p99 86.6ms (n=60)
- quiet mode: p50 73.6ms · p95 77.1ms · p99 83.3ms (n=60)

## 2. MCP tool round-trips (packaged server, real stdio)

- cold start + handshake: 123.0ms
- guardian_get_contract: p50 1.7ms · p95 2.9ms · p99 7.7ms (n=50)
- guardian_check_action: p50 2.1ms · p95 3.7ms · p99 7.4ms (n=50)
- guardian_get_status: p50 2.0ms · p95 2.8ms · p99 4.1ms (n=50)
- guardian_declare_intent: p50 2.0ms · p95 2.6ms · p99 3.6ms (n=50)

## 3. State store (real fs, event-sourced)

- 1000 dispatches (append + reduce + hash + atomic write + contract sync): 4183ms total · 4.18ms/action
- full replay of 1000 actions: 195.2ms
- rebuild (load + replay + write): 197.9ms

## 4. Lexical drift accuracy (labeled set)

- strict: precision 100% · recall 90% (tp=9 fp=0 fn=1 tn=10)
- balanced: precision 100% · recall 90% (tp=9 fp=0 fn=1 tn=10)
- lenient: precision 100% · recall 90% (tp=9 fp=0 fn=1 tn=10)

## 5. Semantic judge accuracy (REAL cursor-agent, billed)

- accuracy: 20/20 (100%) on 20 labeled cases · 2 calls · 65.4s total
