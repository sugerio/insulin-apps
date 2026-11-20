# Quarry Data Warehouse

Quarry is the analytics data warehouse.

## Loading

The nightly ETL job loads the previous day's events at 04:00 UTC. Tables are partitioned by event_date.

## Personal data

Columns that contain personal data are hashed with SHA-256 and a salt before they are loaded. The salt is rotated every quarter by the data platform team.

## Access

Analysts get read access through the analytics role. Write access to production schemas is limited to the ETL service account.
