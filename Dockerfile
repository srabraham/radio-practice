FROM golang:1.27-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /radio .

FROM debian:bookworm-slim
# ca-certificates lets the server reach Let's Encrypt.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /radio /usr/local/bin/radio
# 8080 for plain HTTP (local or behind a proxy); 80 and 443 with -tls-domain
# (ACME HTTP-01 challenge + redirect on 80, HTTPS on 443).
EXPOSE 8080 80 443
ENTRYPOINT ["radio"]
