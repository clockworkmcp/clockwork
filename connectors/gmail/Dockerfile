FROM node:25-slim
WORKDIR /app
COPY gmail.mjs main.mjs ./
ENV CLOCKWORK_GMAIL_DATA=/data/gmail CLOCKWORK_CORE_URL=http://core:4600
CMD ["node", "main.mjs"]
