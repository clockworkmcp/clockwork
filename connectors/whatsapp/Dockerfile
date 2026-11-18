FROM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=1 go build -o /clockwork-whatsapp .
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /clockwork-whatsapp /usr/local/bin/clockwork-whatsapp
ENV CLOCKWORK_WA_DATA=/data/whatsapp CLOCKWORK_WA_LISTEN=0.0.0.0:4599 CLOCKWORK_CORE_URL=http://core:4600
EXPOSE 4599
CMD ["clockwork-whatsapp"]
