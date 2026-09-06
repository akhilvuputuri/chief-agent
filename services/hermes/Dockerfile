FROM python:3.11-slim
ARG HERMES_REF=9c4c548cd555905563b146a6974932b0c5eb8a01
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates build-essential && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv==0.12.10
WORKDIR /opt/hermes
RUN git init . && git remote add origin https://github.com/NousResearch/hermes-agent.git && git fetch --depth 1 origin ${HERMES_REF} && git checkout --detach FETCH_HEAD
RUN uv sync --frozen --no-dev
COPY services/hermes/bridge.py /opt/companion/bridge.py
RUN useradd --uid 10001 --create-home companion && mkdir -p /data/hermes && chown -R companion:companion /data
ENV HERMES_HOME=/data/hermes PYTHONPATH=/opt/hermes PYTHONUNBUFFERED=1
USER companion
CMD ["/opt/hermes/.venv/bin/python", "/opt/companion/bridge.py"]
