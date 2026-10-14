#!/bin/sh
# Safety net around signature_filter.py (F5.31).
#
# signature_filter.py already delivers the original message when anything inside it goes wrong.
# This wrapper covers what it cannot: Python missing, a broken install, a crash before it starts.
# If the filter exits with an error, the message is handed back to Postfix exactly as it arrived,
# so a problem with signatures can delay nothing and lose nothing. Only when Postfix itself refuses
# the message does this exit 75, which makes Postfix keep it and try again later.
#
# Arguments are the ones Postfix passes: -u=<sasl user> -f=<sender> -- <recipients...>

PYTHON="${VEXLYX_PYTHON:-python3}"
FILTER="${VEXLYX_FILTER:-/usr/local/bin/signature_filter.py}"
SENDMAIL="${VEXLYX_SENDMAIL:-/usr/sbin/sendmail}"
EX_TEMPFAIL=75

message="$(mktemp)" || exit "$EX_TEMPFAIL"
trap 'rm -f "$message"' EXIT

cat > "$message" || exit "$EX_TEMPFAIL"

"$PYTHON" "$FILTER" "$@" < "$message"
[ "$?" -eq 0 ] && exit 0

# The filter failed. Deliver the original.
sender=""
seen_separator=0
for argument in "$@"; do
    shift
    if [ "$seen_separator" -eq 1 ]; then
        set -- "$@" "$argument"
    elif [ "$argument" = "--" ]; then
        seen_separator=1
    else
        case "$argument" in
            -f=*) sender="${argument#-f=}" ;;
        esac
    fi
done

[ "$#" -gt 0 ] || exit "$EX_TEMPFAIL"
[ -n "$sender" ] || sender="<>"

"$SENDMAIL" -G -i -f "$sender" -- "$@" < "$message" || exit "$EX_TEMPFAIL"
exit 0
