# syntax=docker/dockerfile:1
#
# The Knowledge engine's container: Cognee, offline, with its models baked in.
#
# Everything a collection knows lives under /data on the root filesystem, so the Durable Object's
# ctx.container.snapshotContainer() captures it. The container runs without internet (enableInternet: false).
# Packages are installed from requirements.lock, which pins every one by version and hash (README.md,
# "The container image").

FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.lock /app/requirements.lock
RUN pip install --require-hashes --no-deps \
      --index-url https://pypi.org/simple \
      --extra-index-url https://download.pytorch.org/whl/cpu \
      -r /app/requirements.lock \
 && pip check

# Cognee's state: the three databases (SQLite, LanceDB, the Ladybug graph) under /data/system/databases, the
# documents it stored under /data/documents. The engine's own files sit beside them: /data/text (redacted texts and
# page maps), /data/passages (where each passage is in its text), /data/facts.json and /data/ledger.json.
# KNOWLEDGE_DATA_FORMAT names the database format: when it changes, collections are learned again from their
# stored text instead of copying an old backup's database files.
ENV DATA_ROOT_DIRECTORY=/data/documents \
    SYSTEM_ROOT_DIRECTORY=/data/system \
    CACHE_ROOT_DIRECTORY=/data/cache \
    COGNEE_LOGS_DIR=/var/log/cognee \
    COGNEE_REPOS_DIR=/var/lib/cognee/repos \
    ENABLE_BACKEND_ACCESS_CONTROL=false \
    TELEMETRY_DISABLED=1 \
    GLINER_AUTO_INSTALL=false \
    HF_HOME=/opt/models/hf \
    TIKTOKEN_CACHE_DIR=/opt/models/tiktoken \
    KNOWLEDGE_DATASET=knowledge \
    KNOWLEDGE_DATA_FORMAT=cognee-1.6.8+knowledge-1 \
    KNOWLEDGE_INBOX=/var/lib/knowledge/inbox \
    KNOWLEDGE_RUN=/var/lib/knowledge/run \
    KNOWLEDGE_WORK=/var/lib/knowledge/work

# Download and load the local extraction (GLiNER) and embedding (fastembed) models through Cognee's own loaders.
# No database is opened at build time. Only the model cache under /opt/models survives into the image.
COPY warmup.py extract.py hide.py offsets.py passages.py rank.py facts.py /app/
RUN DATA_ROOT_DIRECTORY=/tmp/warmup/documents \
    SYSTEM_ROOT_DIRECTORY=/tmp/warmup/system \
    CACHE_ROOT_DIRECTORY=/tmp/warmup/cache \
    python /app/warmup.py \
 && rm -rf /tmp/warmup /var/log/cognee /root/.cognee /root/.cache/pip

# From here on, never touch the network. With enableInternet: false every DNS lookup times out, so anything that
# phones home at import would stall an op.
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    LITELLM_LOCAL_MODEL_COST_MAP=True

# tini is PID 1 so database worker processes that outlive an op get reaped. Pinned to the version in bookworm's
# signed index for the base image above (apt-cache policy tini); a newer Debian build of it means updating the pin.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini=0.19.0-1+b3 \
 && rm -rf /var/lib/apt/lists/*

# /data is empty in the image. Cognee creates its databases on the first import; a snapshot brings them back.
RUN mkdir -p /data /var/log/cognee /var/lib/knowledge

COPY server.py ops.py query.py calibration.json /app/

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "/app/server.py"]
