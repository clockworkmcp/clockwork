FROM node:25-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.mjs ./
ENV CLOCKWORK_DATA=/data CLOCKWORK_HOST=0.0.0.0
EXPOSE 4600
CMD ["node", "server.mjs"]
