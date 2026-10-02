FROM golang:1.27-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /radio .

FROM debian:bookworm-slim
COPY --from=build /radio /usr/local/bin/radio
EXPOSE 8080
ENTRYPOINT ["radio"]
