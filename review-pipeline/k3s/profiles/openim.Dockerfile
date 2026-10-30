# The Go toolchain and the module cache of the checkout's go.mod; the PR's code arrives at run time and fetches only what it changed.
FROM golang:1.26
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
