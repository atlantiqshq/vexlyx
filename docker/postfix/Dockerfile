FROM alpine:3.20

# Install Postfix, OpenDKIM, OpenSSL, and utilities
RUN apk add --no-cache \
    postfix \
    opendkim \
    opendkim-utils \
    openssl \
    ca-certificates \
    cyrus-sasl \
    bash \
    python3

# Create required directories
RUN mkdir -p /etc/postfix /etc/opendkim /var/spool/postfix /var/run/opendkim /var/log/postfix

# Copy configurations
COPY main.cf /etc/postfix/main.cf
COPY master.cf /etc/postfix/master.cf
COPY opendkim.conf /etc/opendkim/opendkim.conf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY signature_filter.py signature_filter.sh /usr/local/bin/

RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh /usr/local/bin/signature_filter.py /usr/local/bin/signature_filter.sh && \
    chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/signature_filter.py /usr/local/bin/signature_filter.sh

# Server-side signatures (F5.31): the content filter runs as its own unprivileged user. It reads the
# per-mailbox files the panel writes (mounted read-only at /etc/vexlyx/signatures) and keeps its
# counters in /var/lib/vexlyx.
RUN adduser -S -D -H -s /sbin/nologin sigfilter && \
    mkdir -p /etc/vexlyx/signatures /var/lib/vexlyx && \
    chown sigfilter /var/lib/vexlyx

# Expose SMTP (25) and Submission (587)
EXPOSE 25 587 8891

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
