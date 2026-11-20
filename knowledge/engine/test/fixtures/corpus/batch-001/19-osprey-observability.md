# Osprey Observability Platform

Osprey collects metrics, traces and logs for every service.

## Retention

Metrics are retained for 13 months. Logs are retained for 30 days in indexes named osprey-logs-*.

## Tracing

Requests are traced at a sampling rate of 8 percent. Errors are always traced.

## Default alerts

Every service gets a default alert that fires when p99 latency stays above 750 milliseconds for 10 minutes.
