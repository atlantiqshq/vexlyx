#!/usr/bin/env python3
"""
signature_filter.py -- Postfix content filter that adds a mailbox's signature to
mail sent from any client over the submission port (F5.31).

Where it sits: the submission service pipes each message through this script
(master.cf, content_filter=sigfilter) and the script hands the result back to
Postfix with sendmail. Re-injected mail is signed by OpenDKIM because OpenDKIM
runs on that path (non_smtpd_milters), so the signature is added BEFORE the DKIM
signature is computed and the DKIM signature stays valid. The submission service
therefore has no milter of its own.

What it never does, so it can be switched on safely:
  * It fails open. Anything unexpected delivers the original message untouched.
  * A message it skips is passed on byte for byte, not re-serialised.
  * It leaves alone signed (S/MIME, PGP, multipart/signed) and encrypted mail,
    calendar invitations, delivery reports, bounces, auto-replies and anything
    it has already signed, so replies and forwards don't pile signatures up.
  * It only reads files the panel writes; it has no database access.

Standard library only.
"""

import email
import html
import json
import os
import quopri
import re
import subprocess
import sys
import time
from datetime import datetime
from email import policy
from email.message import Message

try:
    import fcntl
except ImportError:  # Windows, where only the tests run; the mail server is Linux
    fcntl = None

SIGNATURES_DIR = os.environ.get("VEXLYX_SIGNATURES_DIR", "/etc/vexlyx/signatures")
STATS_PATH = os.environ.get("VEXLYX_SIGNATURE_STATS", "/var/lib/vexlyx/signature_stats.json")
SENDMAIL = os.environ.get("VEXLYX_SENDMAIL", "/usr/sbin/sendmail")
MAX_BYTES = int(os.environ.get("VEXLYX_SIGNATURE_MAX_BYTES", str(10 * 1024 * 1024)))

EX_TEMPFAIL = 75
MARKER_HEADER = "X-Vexlyx-Signature"

# Same rule the panel applies when it writes the file, so a crafted username can't reach another path.
ADDRESS_RE = re.compile(r"[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,}")

# Parsing without refolding headers: whatever the client sent is written back as it was.
MESSAGE_POLICY = policy.compat32.clone(max_line_length=0)


class Skip(Exception):
    """The message is deliberately left alone. The text is the reason, used for the counters."""


# ---------------------------------------------------------------------------
# Reading the panel's file
# ---------------------------------------------------------------------------


def _read_json(path: str):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def load_signature_data(username: str, directory: str = SIGNATURES_DIR):
    address = username.lower()
    if not ADDRESS_RE.fullmatch(address):
        return None
    data = _read_json(os.path.join(directory, address + ".json"))
    return data if data is not None and data.get("v") == 1 else None


def global_enabled(directory: str = SIGNATURES_DIR) -> bool:
    data = _read_json(os.path.join(directory, "_global.json"))
    return data is None or data.get("enabled", True) is not False


def parse_time(value) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def compose(data: dict, now: float) -> tuple[str, str] | None:
    """The signature as (html, text): the personal part, banners inside their dates, then the legal footer.
    Mirrors composeSignature() in packages/shared."""
    blocks = []
    signature = data.get("signature")
    if isinstance(signature, dict) and isinstance(signature.get("html"), str):
        blocks.append(signature)
    for banner in data.get("banners") or []:
        start, end = parse_time(banner.get("startsAt")), parse_time(banner.get("endsAt"))
        if start is not None and end is not None and start <= now < end and isinstance(banner.get("html"), str):
            blocks.append(banner)
    compliance = data.get("compliance")
    if isinstance(compliance, dict) and isinstance(compliance.get("html"), str):
        blocks.append(compliance)
    if not blocks:
        return None
    text_parts = [b.get("text", "") for b in blocks if b.get("text", "") != ""]
    return "".join(b["html"] for b in blocks), "-- \n" + "\n\n".join(text_parts)


# ---------------------------------------------------------------------------
# Deciding whether to touch a message
# ---------------------------------------------------------------------------

SIGNED_OR_ENCRYPTED_TYPES = {
    "multipart/signed",
    "multipart/encrypted",
    "application/pkcs7-mime",
    "application/x-pkcs7-mime",
    "application/pkcs7-signature",
    "application/x-pkcs7-signature",
    "application/pgp-encrypted",
    "application/pgp-signature",
    "application/pgp-keys",
}
REPORT_TYPES = {"multipart/report", "message/delivery-status", "message/disposition-notification"}
CALENDAR_TYPES = {"text/calendar", "application/ics"}
PGP_INLINE = re.compile(rb"-----BEGIN PGP (MESSAGE|SIGNED MESSAGE|SIGNATURE)-----")
REPLY_SUBJECT = re.compile(r"^\s*((re|aw|sv|vs|antw|odp|rv|fwd?|wg|tr|enc|rif)(\[\d+\])?\s*:\s*)+", re.I)
AUTO_PRECEDENCE = {"bulk", "junk", "auto_reply", "auto-reply"}


def walk(part: Message):
    yield part
    if part.is_multipart():
        for child in part.get_payload():
            yield from walk(child)


def check_skip_reasons(msg: Message, raw: bytes, sender: str) -> None:
    if sender == "" or sender == "<>":
        raise Skip("bounce")

    auto = (msg.get("Auto-Submitted") or "").strip().lower()
    if auto and auto != "no":
        raise Skip("auto_reply")
    if msg.get("X-Autoreply") or msg.get("X-Autorespond"):
        raise Skip("auto_reply")
    if (msg.get("Precedence") or "").strip().lower() in AUTO_PRECEDENCE:
        raise Skip("auto_reply")
    if msg.get(MARKER_HEADER):
        raise Skip("already_signed")

    for part in walk(msg):
        kind = part.get_content_type()
        if kind in SIGNED_OR_ENCRYPTED_TYPES:
            raise Skip("signed_or_encrypted")
        if kind in REPORT_TYPES:
            raise Skip("report")
        if kind in CALENDAR_TYPES:
            raise Skip("calendar")
    if PGP_INLINE.search(raw):
        raise Skip("signed_or_encrypted")


def is_reply(msg: Message) -> bool:
    if msg.get("In-Reply-To") or msg.get("References"):
        return True
    return bool(REPLY_SUBJECT.match(msg.get("Subject") or ""))


def is_attachment(part: Message) -> bool:
    disposition = (part.get("Content-Disposition") or "").lower()
    return disposition.startswith("attachment") or part.get_filename() is not None


def body_parts(part: Message) -> list[Message]:
    """The text parts that make up the visible body: both halves of an alternative, the
    first body of anything else, never an attachment."""
    kind = part.get_content_type()
    if not part.is_multipart():
        if kind in ("text/plain", "text/html") and not is_attachment(part):
            return [part]
        return []
    children = part.get_payload()
    if kind == "multipart/alternative":
        found = []
        for child in children:
            found.extend(body_parts(child))
        return found
    if kind == "multipart/related":
        return body_parts(children[0]) if children else []
    for child in children:
        found = body_parts(child)
        if found:
            return found
    return []


# ---------------------------------------------------------------------------
# Finding quoted text, so a reply's signature goes above it and old ones don't count
# ---------------------------------------------------------------------------

ATTRIBUTION = re.compile(r"^(on|am|le|el|il|op)\s.+\b(wrote|schrieb|a écrit|escribió|ha scritto|schreef)\s*:\s*$", re.I)
ORIGINAL_MESSAGE = re.compile(r"^-{2,}\s*(original message|forwarded message|ursprüngliche nachricht)\s*-{2,}\s*$", re.I)


def plain_quote_start(lines: list[str]) -> int | None:
    """Index of the first line of quoted material, or None. An attribution line
    ("On Tue … wrote:") counts as the start of the quote it introduces."""
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith(">"):
            before = lines[index - 1].strip() if index > 0 else ""
            if index > 0 and ATTRIBUTION.match(before):
                return index - 1
            # An attribution that the client wrapped onto two lines.
            if index > 1 and before.lower() == "wrote:" and lines[index - 2].strip().lower().startswith(("on ", "am ", "le ")):
                return index - 2
            return index
        if ORIGINAL_MESSAGE.match(stripped):
            return index
        if ATTRIBUTION.match(stripped) and index + 1 < len(lines) and lines[index + 1].strip().startswith(">"):
            return index
    return None


HTML_QUOTE_STARTS = re.compile(
    r"<blockquote\b"
    r"|<div[^>]+class=[\"'][^\"']*(gmail_quote|moz-cite-prefix|yahoo_quoted|gmail_attr)[^\"']*[\"']"
    r"|<div[^>]+id=[\"'](divRplyFwdMsg|appendonsend|mail-editor-reference-message-container)[\"']"
    r"|<div[^>]+name=[\"']quote[\"']",
    re.I,
)
BODY_END = re.compile(r"</body\s*>", re.I)


def html_quote_start(markup: str) -> int | None:
    match = HTML_QUOTE_STARTS.search(markup)
    return match.start() if match else None


def visible_text(markup: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", markup))).strip()


def normalise(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


# ---------------------------------------------------------------------------
# Adding the signature
# ---------------------------------------------------------------------------


def decode_part(part: Message) -> str:
    payload = part.get_payload(decode=True)
    if payload is None:
        raise ValueError("part has no payload")
    charset = part.get_content_charset() or "utf-8"
    return payload.decode(charset)  # strict: a wrong charset must fail open, never garble the text


def encode_part(part: Message, text: str) -> None:
    """Writes text back as UTF-8, quoted-printable, with matching headers."""
    subtype = part.get_content_subtype()
    body = quopri.encodestring(text.replace("\r\n", "\n").encode("utf-8")).decode("ascii")
    for header in ("Content-Transfer-Encoding", "Content-Type"):
        del part[header]
    part["Content-Type"] = f'text/{subtype}; charset="utf-8"'
    part["Content-Transfer-Encoding"] = "quoted-printable"
    part.set_payload(body)


def is_quote_line(line: str) -> bool:
    stripped = line.strip()
    return stripped == "" or stripped.startswith(">") or stripped.lower() == "wrote:" or ATTRIBUTION.match(stripped) is not None


def place_plain(text: str, block: str) -> str:
    """Adds the plain-text block: above the quoted text when the author wrote on top of it,
    otherwise at the end (which is also right for bottom-posting and interleaved replies)."""
    text = text.replace("\r\n", "\n")
    lines = text.split("\n")
    start = plain_quote_start(lines)
    if start is not None and start > 0:
        quoted = lines[start:]
        # Everything from here down is the old message: either an "Original Message" divider
        # (whose text isn't ">"-quoted) or an attribution (one or two lines) followed by nothing
        # but quote lines.
        first_quote = next((i for i, line in enumerate(quoted) if line.strip().startswith(">")), None)
        top_posted = ORIGINAL_MESSAGE.match(lines[start].strip()) is not None or (
            first_quote is not None and first_quote <= 2 and all(is_quote_line(line) for line in quoted[first_quote:])
        )
        written = "\n".join(lines[:start]).rstrip()
        if written and top_posted:
            return written + "\n\n" + block + "\n\n" + "\n".join(quoted).lstrip("\n")
    return text.rstrip() + "\n\n" + block + "\n"


def place_html(markup: str, block: str) -> str:
    start = html_quote_start(markup)
    if start is not None and visible_text(markup[:start]):
        return markup[:start] + "<br>" + block + "<br>" + markup[start:]
    closings = list(BODY_END.finditer(markup))
    insert_at = closings[-1].start() if closings else len(markup)
    return markup[:insert_at] + "<br><br>" + block + markup[insert_at:]


def already_signed(parts: list[Message], data: dict) -> bool:
    """True when this message's own text (not the quoted old messages) already carries the signature:
    the hidden marker our HTML signatures include, or the signature's text typed or inserted by a client."""
    marker = data.get("marker")
    personal = (data.get("signature") or {}).get("text") or (data.get("compliance") or {}).get("text") or ""
    needle = normalise(personal)
    for part in parts:
        try:
            body = decode_part(part)
        except Exception:
            continue
        if part.get_content_type() == "text/html":
            quote = html_quote_start(body)
            own = body if quote is None else body[:quote]
            if marker and f"<!--vx-sig:{marker}-->" in own:
                return True
            if needle and needle in normalise(visible_text(own)):
                return True
        else:
            lines = body.replace("\r\n", "\n").split("\n")
            quote = plain_quote_start(lines)
            own = "\n".join(lines if quote is None else lines[:quote])
            if needle and needle in normalise(own):
                return True
    return False


def apply_signature(msg: Message, raw: bytes, username: str, recipients: list[str], sender: str, now: float, directory: str = SIGNATURES_DIR) -> bool:
    """Adds the signature to msg in place. Raises Skip with a reason when it should not."""
    if not global_enabled(directory):
        raise Skip("switched_off")
    data = load_signature_data(username, directory)
    if data is None:
        raise Skip("no_signature")
    if data.get("enforceServerSide") is not True:
        raise Skip("not_enforced")

    check_skip_reasons(msg, raw, sender)

    rules = data.get("rules") or {}
    if rules.get("newMessagesOnly") and is_reply(msg):
        raise Skip("reply")
    if rules.get("externalOnly"):
        internal = {d.lower() for d in data.get("internalDomains") or []}
        outside = [r for r in recipients if r.rpartition("@")[2].lower() not in internal]
        if recipients and not outside:
            raise Skip("internal")

    composed = compose(data, now)
    if composed is None:
        raise Skip("nothing_to_add")
    block_html, block_text = composed

    parts = body_parts(msg)
    if not parts:
        raise Skip("no_text_part")
    # A text part in an unusual subtype (markdown, enriched, …) is not ours to edit.
    if any(p.get_content_type() not in ("text/plain", "text/html") for p in parts):
        raise Skip("no_text_part")

    if already_signed(parts, data):
        raise Skip("already_signed")

    for part in parts:
        text = decode_part(part)
        if part.get_content_type() == "text/html":
            encode_part(part, place_html(text, block_html))
        else:
            encode_part(part, place_plain(text, block_text))
    msg[MARKER_HEADER] = "v1"
    return True


def process_message(raw: bytes, username: str, sender: str, recipients: list[str], now: float | None = None, directory: str = SIGNATURES_DIR) -> tuple[bytes, str]:
    """Returns (message to deliver, outcome). The outcome is "modified", "skipped:<reason>" or "failed:<error>".
    A message that is not modified is returned as the very same bytes that came in."""
    if len(raw) > MAX_BYTES:
        return raw, "skipped:too_large"
    try:
        msg = email.message_from_bytes(raw, policy=MESSAGE_POLICY)
        apply_signature(msg, raw, username, recipients, sender, time.time() if now is None else now, directory)
        return msg.as_bytes(policy=MESSAGE_POLICY), "modified"
    except Skip as reason:
        return raw, f"skipped:{reason}"
    except Exception as error:  # fail open: any surprise delivers the original
        return raw, f"failed:{type(error).__name__}"


# ---------------------------------------------------------------------------
# Counters the panel shows
# ---------------------------------------------------------------------------


def record(outcome: str, path: str = STATS_PATH) -> None:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a+", encoding="utf-8") as handle:
            if fcntl:
                fcntl.flock(handle, fcntl.LOCK_EX)
            handle.seek(0)
            try:
                stats = json.load(handle)
            except ValueError:
                stats = {}
            stats.setdefault("since", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
            stats.setdefault("modified", 0)
            stats.setdefault("failed", 0)
            stats.setdefault("skipped", {})
            kind, _, detail = outcome.partition(":")
            if kind == "modified":
                stats["modified"] += 1
            elif kind == "failed":
                stats["failed"] += 1
            else:
                stats["skipped"][detail] = stats["skipped"].get(detail, 0) + 1
            handle.seek(0)
            handle.truncate()
            json.dump(stats, handle)
    except Exception:
        pass  # counters are a convenience; they must never block mail


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def inject(message: bytes, sender: str, recipients: list[str]) -> int:
    command = [SENDMAIL, "-G", "-i", "-f", sender if sender else "<>", "--", *recipients]
    return subprocess.run(command, input=message, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode


def parse_arguments(argv: list[str]) -> tuple[str, str, list[str]]:
    """Postfix passes -u=<sasl user> -f=<sender> -- <recipients…>. The "=" form keeps an empty value from shifting arguments."""
    username = sender = ""
    recipients: list[str] = []
    rest = False
    for argument in argv:
        if rest:
            recipients.append(argument)
        elif argument == "--":
            rest = True
        elif argument.startswith("-u="):
            username = argument[3:]
        elif argument.startswith("-f="):
            sender = argument[3:]
    return username, sender, recipients


def main(argv: list[str]) -> int:
    username, sender, recipients = parse_arguments(argv)
    if not recipients:
        return EX_TEMPFAIL
    raw = sys.stdin.buffer.read()

    delivered, outcome = process_message(raw, username, sender, recipients)
    record(outcome)

    if inject(delivered, sender, recipients) == 0:
        return 0
    if delivered is not raw:
        # The edited message was refused. The original is still deliverable.
        record("failed:rejected_edit")
        if inject(raw, sender, recipients) == 0:
            return 0
    return EX_TEMPFAIL  # Postfix keeps the mail and tries again; nothing is lost


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except BaseException:
        sys.exit(EX_TEMPFAIL)
