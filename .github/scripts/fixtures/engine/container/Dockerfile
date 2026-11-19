# syntax=docker/dockerfile:1
# A synthetic image: the digests are placeholders, never a real image's.
FROM python:3.12-slim@sha256:1111111111111111111111111111111111111111111111111111111111111111 AS base

WORKDIR /app
COPY requirements.lock /app/requirements.lock
RUN pip install --no-deps --require-hashes \
      -r /app/requirements.lock

FROM base
COPY server/ /app/server/
CMD ["python", "-m", "server.main"]
