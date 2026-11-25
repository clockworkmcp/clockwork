# One image = one user's whole Clockwork instance (core, student, trainer, WhatsApp and Gmail connectors).
# A single container with one data volume maps cleanly onto "one small VM per user".
FROM golang:1.27-bookworm AS whatsapp
WORKDIR /src
COPY connectors/whatsapp/go.mod connectors/whatsapp/go.sum ./
RUN go mod download
COPY connectors/whatsapp/main.go ./
RUN CGO_ENABLED=1 go build -o /clockwork-whatsapp .

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates tini gosu tzdata \
      chromium chromium-sandbox xvfb fonts-liberation fonts-dejavu-core && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin clockwork
WORKDIR /app
COPY student/requirements.lock student/
# Exact versions from requirements.lock; CPU-only torch keeps the image small (the student never needs a GPU).
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r student/requirements.lock \
    --index-url https://pypi.org/simple --extra-index-url https://download.pytorch.org/whl/cpu
COPY core/package.json core/package-lock.json core/
RUN cd core && npm ci --omit=dev
COPY core/*.mjs core/
COPY student/*.py student/
COPY connectors/gmail/gmail.mjs connectors/gmail/main.mjs connectors/gmail/
COPY connectors/x-cloud/main.mjs connectors/x-cloud/
COPY extractors/gmail-imap/main.mjs extractors/gmail-imap/imap.mjs extractors/gmail-imap/mail.mjs extractors/gmail-imap/
COPY --from=whatsapp /clockwork-whatsapp /usr/local/bin/clockwork-whatsapp
COPY scripts/run-instance.sh /usr/local/bin/run-instance
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/run-instance /usr/local/bin/entrypoint
ENV CLOCKWORK_DATA=/data CLOCKWORK_HOST=0.0.0.0 CLOCKWORK_WA_DATA=/data/whatsapp CLOCKWORK_WA_LISTEN=[::]:4599 \
    CLOCKWORK_GMAIL_DATA=/data/gmail CLOCKWORK_X_DATA=/data/x-cloud CLOCKWORK_X_LOGIN_HOST=:: CLOCKWORK_CORE_URL=http://127.0.0.1:4600 HF_HOME=/data/student/hf PATH=/opt/venv/bin:$PATH
VOLUME /data
EXPOSE 4600 4599
ENTRYPOINT ["tini", "--", "entrypoint"]
