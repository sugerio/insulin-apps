# Pelican Queue Service

Pelican is the managed message queue for asynchronous work.

## Delivery

Pelican delivers messages at least once. Consumers must be idempotent.

## Visibility timeout

A received message is hidden from other consumers for a visibility timeout of 45 seconds. A consumer that needs longer must extend the timeout.

## Dead letters

A message moves to the dead-letter queue after 5 failed delivery attempts. The maximum message size is 256 KB.
