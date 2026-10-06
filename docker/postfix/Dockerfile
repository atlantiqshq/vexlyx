FROM alpine:3.20

# Install Postfix, OpenDKIM, OpenSSL, and utilities
RUN apk add --no-cache \
    postfix \
    opendkim \
    opendkim-utils \
    openssl \
    ca-certificates \
    cyrus-sasl \
    bash

# Create required directories
RUN mkdir -p /etc/postfix /etc/opendkim /var/spool/postfix /var/run/opendkim /var/log/postfix

# Copy configurations
COPY main.cf /etc/postfix/main.cf
COPY master.cf /etc/postfix/master.cf
COPY opendkim.conf /etc/opendkim/opendkim.conf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && \
    chmod +x /usr/local/bin/entrypoint.sh

# Expose SMTP (25) and Submission (587)
EXPOSE 25 587 8891

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
