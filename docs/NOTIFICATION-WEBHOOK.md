# Notification webhook contract

Yuki's optional external notification channel sends HTTPS `POST` requests with
`Content-Type: application/json`. Configure it from Installation Settings.

## Request

Every request includes:

- `User-Agent: Yuki-Notification-Webhook/1`
- `Idempotency-Key: <notification ID>`
- `Authorization: Bearer <token>` only when a bearer token is configured

The JSON body uses the stable `yuki.notification.v1` contract:

```json
{
  "schema": "yuki.notification.v1",
  "notificationId": "00000000-0000-4000-8000-000000000001",
  "kind": "print_completed",
  "occurredAt": "2026-07-29T08:00:00.000Z",
  "title": "Print completed",
  "message": "Workshop: cube.gcode",
  "printAttemptId": "00000000-0000-4000-8000-000000000002",
  "printerId": "00000000-0000-4000-8000-000000000003",
  "facts": {
    "schemaVersion": 1,
    "state": "completed",
    "outcome": "successful"
  }
}
```

`kind` is one of `print_completed`, `print_failed`, `print_cancelled`, or
`printer_disconnected`. Attempt and printer IDs may be `null`. Receivers should
ignore unknown fields added compatibly and deduplicate using `notificationId`
or `Idempotency-Key`.

## Delivery behavior

Any HTTP 2xx response succeeds. Network failures, timeouts, HTTP 408, 425, 429,
and 5xx responses retry through the durable job queue, up to five total
attempts. Other responses fail permanently. At-least-once delivery means an
ambiguous network failure can produce a duplicate request.

Yuki disables redirects, permits only public HTTPS destinations, pins the
connection to a policy-approved DNS result, sends at most 64 KiB, waits at most
ten seconds, and retains at most 64 KiB of response traffic. Response bodies are
never stored. Installation Settings shows sanitized status, attempt count, HTTP
status, and error diagnostics.
