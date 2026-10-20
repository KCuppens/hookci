# VERSION is what GET / reports. The build arg wins; without it the image
# reports the VERSION file of the commit, so each deployed commit can carry
# its own version without build args.
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod main.go VERSION ./
ARG VERSION
RUN v="${VERSION:-$(cat VERSION)}" \
	&& CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${v}" -o /out/compose-app .

FROM scratch
COPY --from=build /out/compose-app /compose-app
EXPOSE 8080
ENTRYPOINT ["/compose-app"]
