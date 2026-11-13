# The agent's only way to the internet: a forward proxy that refuses everything but the hosts Po decides to allow.
FROM alpine:3.20
RUN apk add --no-cache squid
COPY squid.conf /etc/squid/squid.conf
USER squid
EXPOSE 3128
CMD ["squid", "-N", "-f", "/etc/squid/squid.conf"]
