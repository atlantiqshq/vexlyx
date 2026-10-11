"""Tests for signature_filter.py (F5.31).

Run: python -m unittest docker/postfix/test_signature_filter.py

The rule these tests protect: the filter may add a signature, or leave a message
exactly as it came in. It must never garble, lose or duplicate anything.
"""

import base64
import email
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from email import policy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import signature_filter as sf  # noqa: E402

NOW = 1_791_892_800.0  # 2026-10-13T12:00:00Z
MARKER = "abc123def456"
SIG_HTML = f"<!--vx-sig:{MARKER}--><div>Ada Lovelace<br>Engineer</div>"
SIG_TEXT = "Ada Lovelace\nEngineer"
ADA = "ada@example.com"


def signature_data(**overrides):
    data = {
        "v": 1,
        "address": ADA,
        "marker": MARKER,
        "locked": False,
        "enforceServerSide": True,
        "signature": {"html": SIG_HTML, "text": SIG_TEXT},
        "compliance": None,
        "banners": [],
        "rules": {"externalOnly": False, "newMessagesOnly": False},
        "internalDomains": ["example.com"],
    }
    data.update(overrides)
    return data


HEADERS = "From: Ada <ada@example.com>\nTo: bob@other.org\nSubject: Hello\nDate: Tue, 13 Oct 2026 12:00:00 +0000\nMessage-ID: <1@example.com>\nMIME-Version: 1.0\n"


def plain(body: str, extra_headers: str = "", charset: str = "utf-8", cte: str = "8bit") -> bytes:
    return (HEADERS + extra_headers + f'Content-Type: text/plain; charset="{charset}"\nContent-Transfer-Encoding: {cte}\n\n' + body).encode(charset)


def html_message(body: str, extra_headers: str = "") -> bytes:
    return (HEADERS + extra_headers + 'Content-Type: text/html; charset="utf-8"\nContent-Transfer-Encoding: 8bit\n\n' + body).encode("utf-8")


def multipart(kind: str, parts: list, boundary: str = "BOUNDARY", extra_headers: str = "") -> bytes:
    text = HEADERS + extra_headers + f'Content-Type: multipart/{kind}; boundary="{boundary}"\n\n'
    for header_block, body in parts:
        text += f"--{boundary}\n{header_block}\n\n{body}\n"
    text += f"--{boundary}--\n"
    return text.encode("utf-8")


def text_part(body: str, subtype: str = "plain") -> tuple:
    return (f'Content-Type: text/{subtype}; charset="utf-8"\nContent-Transfer-Encoding: 8bit', body)


class FilterCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.write(ADA, signature_data())

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def write(self, address: str, data) -> None:
        Path(self.dir, f"{address}.json").write_text(json.dumps(data), encoding="utf-8")

    def run_filter(self, raw: bytes, username: str = ADA, sender: str = ADA, recipients=None, now: float = NOW):
        return sf.process_message(raw, username, sender, recipients or ["bob@other.org"], now, self.dir)

    def assert_untouched(self, raw: bytes, reason: str, **kwargs) -> None:
        out, outcome = self.run_filter(raw, **kwargs)
        self.assertEqual(outcome, f"skipped:{reason}")
        self.assertIs(out, raw, "a skipped message must be returned as the very same bytes")

    def parsed(self, raw: bytes):
        return email.message_from_bytes(raw, policy=policy.default)

    def body_text(self, raw: bytes) -> str:
        part = self.parsed(raw).get_body(preferencelist=("plain",))
        return part.get_content()

    def body_html(self, raw: bytes) -> str:
        part = self.parsed(raw).get_body(preferencelist=("html",))
        return part.get_content()


class AddingTheSignature(FilterCase):
    def test_appends_to_a_plain_text_message(self):
        out, outcome = self.run_filter(plain("Hello Bob\n"))
        self.assertEqual(outcome, "modified")
        self.assertEqual(self.body_text(out), "Hello Bob\n\n-- \nAda Lovelace\nEngineer\n")
        self.assertEqual(self.parsed(out)["X-Vexlyx-Signature"], "v1")

    def test_inserts_into_html_before_the_closing_body_tag(self):
        out, outcome = self.run_filter(html_message("<html><body><p>Hi Bob</p></body></html>"))
        self.assertEqual(outcome, "modified")
        html = self.body_html(out)
        self.assertIn("<p>Hi Bob</p><br><br>" + SIG_HTML + "</body></html>", html)

    def test_signs_both_halves_of_an_alternative_message(self):
        raw = multipart("alternative", [text_part("Hi Bob"), text_part("<p>Hi Bob</p>", "html")])
        out, outcome = self.run_filter(raw)
        self.assertEqual(outcome, "modified")
        self.assertIn("-- \nAda Lovelace", self.body_text(out))
        self.assertIn(MARKER, self.body_html(out))

    def test_signs_the_body_of_a_message_with_an_attachment_and_leaves_the_attachment_alone(self):
        pdf = base64.b64encode(b"%PDF-1.4 fake attachment bytes").decode()
        raw = multipart(
            "mixed",
            [
                text_part("See attached"),
                ('Content-Type: application/pdf; name="a.pdf"\nContent-Disposition: attachment; filename="a.pdf"\nContent-Transfer-Encoding: base64', pdf),
            ],
        )
        out, outcome = self.run_filter(raw)
        self.assertEqual(outcome, "modified")
        message = self.parsed(out)
        self.assertEqual(message.get_body(preferencelist=("plain",)).get_content(), "See attached\n\n-- \nAda Lovelace\nEngineer\n")
        attachment = [p for p in message.walk() if p.get_content_type() == "application/pdf"][0]
        self.assertEqual(attachment.get_content(), b"%PDF-1.4 fake attachment bytes")

    def test_does_not_touch_a_text_file_that_is_an_attachment(self):
        raw = multipart(
            "mixed",
            [
                text_part("The message"),
                ('Content-Type: text/plain; name="notes.txt"\nContent-Disposition: attachment; filename="notes.txt"\nContent-Transfer-Encoding: 8bit', "NOTES"),
            ],
        )
        out, _ = self.run_filter(raw)
        notes = [p for p in self.parsed(out).walk() if p.get_filename() == "notes.txt"][0]
        self.assertEqual(notes.get_content().strip(), "NOTES")

    def test_signs_only_the_first_body_of_a_mixed_message(self):
        raw = multipart("mixed", [text_part("First"), text_part("Second")])
        out, _ = self.run_filter(raw)
        texts = [p.get_content() for p in self.parsed(out).walk() if p.get_content_type() == "text/plain"]
        self.assertIn("-- \nAda", texts[0])
        self.assertNotIn("Ada", texts[1])

    def test_signs_the_html_of_a_related_message_not_its_images(self):
        image = base64.b64encode(b"\x89PNGfake").decode()
        inner = multipart("related", [text_part("<p>Logo below</p>", "html"), ("Content-Type: image/png\nContent-ID: <logo>\nContent-Transfer-Encoding: base64", image)], "INNER")
        # Wrap by hand: related inside alternative
        raw = multipart(
            "alternative",
            [text_part("Logo below"), ('Content-Type: multipart/related; boundary="INNER"', inner.split(b"\n\n", 1)[1].decode())],
        )
        out, outcome = self.run_filter(raw)
        self.assertEqual(outcome, "modified")
        html = [p for p in self.parsed(out).walk() if p.get_content_type() == "text/html"][0].get_content()
        self.assertIn(MARKER, html)
        self.assertEqual([p for p in self.parsed(out).walk() if p.get_content_type() == "image/png"][0].get_content(), b"\x89PNGfake")

    def test_keeps_every_original_header(self):
        extra = "X-Mailer: Thunderbird\nReceived: from a by b; Tue, 13 Oct 2026 12:00:00 +0000\nReceived: from c by d; Tue, 13 Oct 2026 12:00:01 +0000\nSubject: =?utf-8?b?w4kgY2Fmw6k=?=\nX-Long: " + "word " * 40 + "\n"
        raw = plain("Hello\n", extra_headers=extra.replace("Subject: =?utf-8?b?w4kgY2Fmw6k=?=\n", "")).replace(b"Subject: Hello\n", b"Subject: =?utf-8?b?w4kgY2Fmw6k=?=\n")
        out, outcome = self.run_filter(raw)
        self.assertEqual(outcome, "modified")
        before, after = self.parsed(raw), self.parsed(out)
        for name in ("From", "To", "Subject", "Date", "Message-ID", "X-Mailer", "X-Long"):
            self.assertEqual(before[name], after[name], name)
        self.assertEqual(before.get_all("Received"), after.get_all("Received"))
        self.assertEqual(str(after["Subject"]), "É café")


class Charsets(FilterCase):
    def test_converts_latin1_text_to_utf8_without_losing_a_character(self):
        raw = plain("Café crème\n", charset="iso-8859-1", cte="8bit")
        out, outcome = self.run_filter(raw)
        self.assertEqual(outcome, "modified")
        self.assertEqual(self.body_text(out), "Café crème\n\n-- \nAda Lovelace\nEngineer\n")
        self.assertIn("utf-8", self.parsed(out)["Content-Type"].lower())

    def test_handles_base64_and_quoted_printable_bodies(self):
        b64 = base64.b64encode("Grüße 🙂\n".encode("utf-8")).decode()
        out, outcome = self.run_filter(plain(b64, cte="base64"))
        self.assertEqual(outcome, "modified")
        self.assertEqual(self.body_text(out), "Grüße 🙂\n\n-- \nAda Lovelace\nEngineer\n")

        qp = "Gr=C3=BC=C3=9Fe\n"
        out, outcome = self.run_filter(plain(qp, cte="quoted-printable"))
        self.assertEqual(self.body_text(out), "Grüße\n\n-- \nAda Lovelace\nEngineer\n")

    def test_fails_open_on_a_charset_it_cannot_decode(self):
        raw = plain("hello", charset="utf-8").replace(b'charset="utf-8"', b'charset="x-no-such-charset"')
        out, outcome = self.run_filter(raw)
        self.assertTrue(outcome.startswith("failed:"), outcome)
        self.assertIs(out, raw)

    def test_fails_open_when_the_bytes_do_not_match_the_declared_charset(self):
        raw = (HEADERS + 'Content-Type: text/plain; charset="utf-8"\nContent-Transfer-Encoding: 8bit\n\n').encode() + b"caf\xe9\n"
        out, outcome = self.run_filter(raw)
        self.assertTrue(outcome.startswith("failed:"), outcome)
        self.assertIs(out, raw)

    def test_leaves_unusual_text_types_alone(self):
        raw = (HEADERS + 'Content-Type: text/enriched; charset="utf-8"\n\n<bold>x</bold>\n').encode()
        self.assert_untouched(raw, "no_text_part")


class Replies(FilterCase):
    QUOTE = "On Mon, Oct 12, 2026 at 9:00 AM Bob <bob@other.org> wrote:\n> Are we on for Friday?\n> Bob\n"

    def test_puts_the_signature_above_the_quoted_text_when_the_reply_is_on_top(self):
        out, outcome = self.run_filter(plain("Yes, Friday works.\n\n" + self.QUOTE))
        self.assertEqual(outcome, "modified")
        self.assertEqual(
            self.body_text(out),
            "Yes, Friday works.\n\n-- \nAda Lovelace\nEngineer\n\n" + self.QUOTE,
        )

    def test_copes_with_an_attribution_the_client_wrapped_onto_two_lines(self):
        quote = "On Mon, Oct 12, 2026 at 9:00 AM Bob Babbage <bob@other.org>\nwrote:\n> Friday?\n"
        out, _ = self.run_filter(plain("Yes.\n\n" + quote))
        self.assertEqual(self.body_text(out), "Yes.\n\n-- \nAda Lovelace\nEngineer\n\n" + quote)

    def test_appends_at_the_end_when_the_reply_is_below_the_quote(self):
        text = "> Are we on for Friday?\n\nYes, Friday works.\n"
        out, _ = self.run_filter(plain(text))
        self.assertEqual(self.body_text(out), text + "\n-- \nAda Lovelace\nEngineer\n")

    def test_appends_at_the_end_of_an_interleaved_reply(self):
        text = "On Mon Bob wrote:\n> Friday?\nYes.\n> Lunch?\nNo.\n"
        out, _ = self.run_filter(plain(text))
        self.assertTrue(self.body_text(out).endswith("No.\n\n-- \nAda Lovelace\nEngineer\n"))

    def test_puts_the_signature_above_an_original_message_divider(self):
        text = "Done.\n\n-----Original Message-----\nFrom: Bob\nSent: Monday\nSubject: Hi\n\nAre we on?\n"
        out, _ = self.run_filter(plain(text))
        self.assertEqual(self.body_text(out), "Done.\n\n-- \nAda Lovelace\nEngineer\n\n" + text.split("Done.\n\n", 1)[1])

    def test_puts_the_signature_above_a_gmail_quote_in_html(self):
        markup = '<html><body><div>Yes, Friday.</div><br><div class="gmail_quote"><div class="gmail_attr">On Mon Bob wrote:</div><blockquote class="gmail_quote">Friday?</blockquote></div></body></html>'
        out, outcome = self.run_filter(html_message(markup))
        self.assertEqual(outcome, "modified")
        html = self.body_html(out)
        self.assertLess(html.index(MARKER), html.index("gmail_quote"))
        self.assertIn("Friday?", html)

    def test_appends_after_the_text_when_html_has_no_quote(self):
        out, _ = self.run_filter(html_message("<div>Hello</div>"))
        self.assertTrue(self.body_html(out).endswith(SIG_HTML))

    def test_a_reply_that_quotes_the_old_signature_still_gets_its_own(self):
        quoted_text = "Thanks.\n\nOn Mon, Oct 12, 2026 at 9:00 AM Ada <ada@example.com> wrote:\n> Hi\n> -- \n> Ada Lovelace\n> Engineer\n"
        out, outcome = self.run_filter(plain(quoted_text), username=ADA)
        self.assertEqual(outcome, "modified", "the old signature is quoted, so it is not this message's own")
        written, _, _ = self.body_text(out).partition("On Mon")
        self.assertIn("-- \nAda Lovelace\nEngineer", written)

        quoted_html = f'<div>Thanks.</div><div class="gmail_quote"><blockquote>Hi{SIG_HTML}</blockquote></div>'
        out, outcome = self.run_filter(html_message(quoted_html))
        self.assertEqual(outcome, "modified")
        html = self.body_html(out)
        self.assertEqual(html.count(MARKER), 2)
        self.assertLess(html.index(MARKER), html.index("gmail_quote"))

    def test_running_the_filter_twice_never_adds_a_second_signature(self):
        once, outcome = self.run_filter(plain("Hello\n\n" + self.QUOTE))
        self.assertEqual(outcome, "modified")
        twice, outcome = self.run_filter(once)
        self.assertEqual(outcome, "skipped:already_signed")
        self.assertIs(twice, once)

        html_once, _ = self.run_filter(html_message("<div>Hi</div>"))
        html_twice, outcome = self.run_filter(html_once)
        self.assertEqual(outcome, "skipped:already_signed")

    def test_leaves_a_message_alone_when_the_client_already_added_the_signature(self):
        self.assert_untouched(plain("Hello\n\n-- \nAda Lovelace\nEngineer\n"), "already_signed")
        self.assert_untouched(html_message("<div>Hi</div><div>Ada  Lovelace<br>Engineer</div>"), "already_signed")


class WhatItNeverTouches(FilterCase):
    def test_signed_and_encrypted_mail(self):
        signed = multipart("signed", [text_part("Hello"), ("Content-Type: application/pgp-signature", "-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----")], extra_headers="").replace(b"multipart/signed", b'multipart/signed; protocol="application/pgp-signature"') if False else None
        raw_signed = (HEADERS + 'Content-Type: multipart/signed; protocol="application/pgp-signature"; micalg=pgp-sha256; boundary="B"\n\n--B\nContent-Type: text/plain\n\nHello\n--B\nContent-Type: application/pgp-signature\n\nsig\n--B--\n').encode()
        self.assert_untouched(raw_signed, "signed_or_encrypted")
        encrypted = (HEADERS + 'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="B"\n\n--B\nContent-Type: application/pgp-encrypted\n\nVersion: 1\n--B\nContent-Type: application/octet-stream\n\nxxxx\n--B--\n').encode()
        self.assert_untouched(encrypted, "signed_or_encrypted")
        smime = (HEADERS + 'Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"\nContent-Transfer-Encoding: base64\n\nAAAA\n').encode()
        self.assert_untouched(smime, "signed_or_encrypted")
        self.assert_untouched(plain("-----BEGIN PGP MESSAGE-----\n\nhQEMA...\n-----END PGP MESSAGE-----\n"), "signed_or_encrypted")
        self.assert_untouched(plain("-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nHi\n"), "signed_or_encrypted")

    def test_calendar_invitations(self):
        invite = multipart("alternative", [text_part("Meeting"), ("Content-Type: text/calendar; method=REQUEST; charset=utf-8", "BEGIN:VCALENDAR\nEND:VCALENDAR")])
        self.assert_untouched(invite, "calendar")

    def test_delivery_reports_and_bounces(self):
        report = (HEADERS + 'Content-Type: multipart/report; report-type=delivery-status; boundary="B"\n\n--B\nContent-Type: text/plain\n\nFailed\n--B\nContent-Type: message/delivery-status\n\nReporting-MTA: dns; x\n--B--\n').encode()
        self.assert_untouched(report, "report")
        self.assert_untouched(plain("Hello\n"), "bounce", sender="")
        self.assert_untouched(plain("Hello\n"), "bounce", sender="<>")

    def test_automatic_replies(self):
        self.assert_untouched(plain("Away\n", extra_headers="Auto-Submitted: auto-replied\n"), "auto_reply")
        self.assert_untouched(plain("Away\n", extra_headers="Precedence: bulk\n"), "auto_reply")
        self.assert_untouched(plain("Away\n", extra_headers="X-Autoreply: yes\n"), "auto_reply")
        out, outcome = self.run_filter(plain("Hello\n", extra_headers="Auto-Submitted: no\n"))
        self.assertEqual(outcome, "modified")

    def test_messages_that_are_not_enforced_or_not_ours(self):
        raw = plain("Hello\n")
        self.assert_untouched(raw, "no_signature", username="nobody@example.com")
        self.assert_untouched(raw, "no_signature", username="")
        self.assert_untouched(raw, "no_signature", username="../../etc/passwd")
        self.assert_untouched(raw, "no_signature", username=ADA + "\n")
        self.write(ADA, signature_data(enforceServerSide=False))
        self.assert_untouched(raw, "not_enforced")
        self.write(ADA, signature_data())
        Path(self.dir, "_global.json").write_text(json.dumps({"v": 1, "enabled": False}))
        self.assert_untouched(raw, "switched_off")

    def test_a_missing_broken_or_empty_signature_file(self):
        raw = plain("Hello\n")
        Path(self.dir, f"{ADA}.json").write_text("{not json")
        self.assert_untouched(raw, "no_signature")
        self.write(ADA, signature_data(v=2))
        self.assert_untouched(raw, "no_signature")
        self.write(ADA, signature_data(signature=None))
        self.assert_untouched(raw, "nothing_to_add")

    def test_oversized_messages(self):
        original = sf.MAX_BYTES
        sf.MAX_BYTES = 50
        try:
            self.assert_untouched(plain("x" * 200), "too_large")
        finally:
            sf.MAX_BYTES = original

    def test_attachment_only_messages(self):
        raw = (HEADERS + 'Content-Type: application/pdf; name="a.pdf"\nContent-Transfer-Encoding: base64\n\nAAAA\n').encode()
        self.assert_untouched(raw, "no_text_part")

    def test_never_adds_a_header_or_changes_a_byte_of_a_skipped_message(self):
        raw = plain("Hello\n", extra_headers="Auto-Submitted: auto-replied\n")
        out, _ = self.run_filter(raw)
        self.assertEqual(out, raw)


class Rules(FilterCase):
    def test_new_messages_only_skips_replies_and_forwards(self):
        self.write(ADA, signature_data(rules={"externalOnly": False, "newMessagesOnly": True}))
        self.assert_untouched(plain("Yes\n", extra_headers="In-Reply-To: <1@x>\n"), "reply")
        self.assert_untouched(plain("Yes\n", extra_headers="References: <1@x>\n"), "reply")
        for subject in ("Re: Hello", "RE: Hello", "Fwd: Hello", "AW: Hello", "Re[2]: Hello"):
            raw = plain("Yes\n").replace(b"Subject: Hello", f"Subject: {subject}".encode())
            self.assert_untouched(raw, "reply")
        out, outcome = self.run_filter(plain("A brand new message\n"))
        self.assertEqual(outcome, "modified")

    def test_a_subject_that_merely_contains_re_is_still_a_new_message(self):
        self.write(ADA, signature_data(rules={"externalOnly": False, "newMessagesOnly": True}))
        raw = plain("x\n").replace(b"Subject: Hello", b"Subject: Regarding the report")
        self.assertEqual(self.run_filter(raw)[1], "modified")

    def test_external_only_skips_mail_that_stays_inside(self):
        self.write(ADA, signature_data(rules={"externalOnly": True, "newMessagesOnly": False}))
        self.assert_untouched(plain("Hi\n"), "internal", recipients=["colleague@example.com", "COLLEAGUE2@Example.com"])
        self.assertEqual(self.run_filter(plain("Hi\n"), recipients=["colleague@example.com", "bob@other.org"])[1], "modified")
        self.assertEqual(self.run_filter(plain("Hi\n"), recipients=["bob@other.org"])[1], "modified")


class BannersAndFooter(FilterCase):
    def banner(self, text, start, end):
        return {"html": f"<p>{text}</p>", "text": text, "startsAt": start, "endsAt": end}

    def test_includes_only_banners_inside_their_dates_and_the_legal_footer(self):
        self.write(
            ADA,
            signature_data(
                compliance={"html": "<small>Registered No. 1</small>", "text": "Registered No. 1"},
                banners=[
                    self.banner("Active", "2026-10-13T00:00:00Z", "2026-10-14T00:00:00Z"),
                    self.banner("Future", "2026-12-01T00:00:00Z", "2026-12-25T00:00:00Z"),
                    self.banner("Ended", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"),
                ],
            ),
        )
        out, _ = self.run_filter(plain("Hello\n"))
        self.assertEqual(self.body_text(out), "Hello\n\n-- \nAda Lovelace\nEngineer\n\nActive\n\nRegistered No. 1\n")
        out, _ = self.run_filter(plain("Hello\n"), now=NOW + 60 * 86400)
        self.assertIn("Future", self.body_text(out))
        self.assertNotIn("Active", self.body_text(out))

    def test_a_legal_footer_alone_still_gets_the_delimiter_once(self):
        self.write(ADA, signature_data(signature=None, compliance={"html": "<small>Legal</small>", "text": "Legal"}))
        out, _ = self.run_filter(plain("Hello\n"))
        self.assertEqual(self.body_text(out), "Hello\n\n-- \nLegal\n")


class Counters(FilterCase):
    def test_counts_modified_skipped_and_failed(self):
        path = os.path.join(self.dir, "stats", "stats.json")
        for outcome in ("modified", "modified", "skipped:reply", "skipped:reply", "skipped:bounce", "failed:ValueError"):
            sf.record(outcome, path)
        stats = json.loads(Path(path).read_text())
        self.assertEqual((stats["modified"], stats["failed"], stats["skipped"]), (2, 1, {"reply": 2, "bounce": 1}))
        self.assertRegex(stats["since"], r"^\d{4}-\d{2}-\d{2}T")

    def test_a_broken_counter_file_never_blocks_mail(self):
        path = os.path.join(self.dir, "stats.json")
        Path(path).write_text("{garbage")
        sf.record("modified", path)  # must not raise
        sf.record("modified", os.path.join(self.dir, "stats.json", "nested", "x.json"))  # unwritable path: ignored


class Arguments(unittest.TestCase):
    def test_parses_what_postfix_passes(self):
        self.assertEqual(
            sf.parse_arguments(["-u=ada@example.com", "-f=ada@example.com", "--", "a@x.com", "b@y.com"]),
            ("ada@example.com", "ada@example.com", ["a@x.com", "b@y.com"]),
        )

    def test_empty_values_do_not_shift_the_arguments(self):
        self.assertEqual(sf.parse_arguments(["-u=", "-f=", "--", "a@x.com"]), ("", "", ["a@x.com"]))

    def test_a_recipient_that_looks_like_an_option_stays_a_recipient(self):
        self.assertEqual(sf.parse_arguments(["-u=a@x.com", "-f=a@x.com", "--", "-f=evil@x.com"])[2], ["-f=evil@x.com"])


@unittest.skipIf(os.name == "nt", "needs a POSIX shell for the fake sendmail")
class EndToEnd(FilterCase):
    """Runs the real script with a stand-in for sendmail that records what it is given."""

    def setUp(self) -> None:
        super().setUp()
        self.out = Path(self.dir, "sent")
        self.out.mkdir()
        self.sendmail = Path(self.dir, "fake-sendmail")
        self.set_sendmail(0)

    def set_sendmail(self, failures_first: int, always_fail: bool = False) -> None:
        counter = Path(self.dir, "count")
        counter.write_text("0")
        self.sendmail.write_text(
            "#!/bin/sh\n"
            f'n=$(cat "{counter}"); n=$((n+1)); echo $n > "{counter}"\n'
            f'printf "%s\\n" "$@" > "{self.out}/args.$n"\n'
            f'cat > "{self.out}/message.$n"\n'
            + ("exit 1\n" if always_fail else f'[ "$n" -le {failures_first} ] && exit 1\nexit 0\n')
        )
        self.sendmail.chmod(self.sendmail.stat().st_mode | stat.S_IXUSR)

    def run_script(self, raw: bytes, args=None):
        env = {**os.environ, "VEXLYX_SIGNATURES_DIR": self.dir, "VEXLYX_SENDMAIL": str(self.sendmail), "VEXLYX_SIGNATURE_STATS": str(Path(self.dir, "stats.json"))}
        return subprocess.run(
            [sys.executable, str(Path(sf.__file__)), *(args or [f"-u={ADA}", f"-f={ADA}", "--", "bob@other.org", "carol@other.org"])],
            input=raw,
            capture_output=True,
            env=env,
        )

    def test_hands_the_signed_message_back_to_postfix_with_the_right_envelope(self):
        result = self.run_script(plain("Hello\n"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.out.joinpath("args.1").read_text().split(), ["-G", "-i", "-f", ADA, "--", "bob@other.org", "carol@other.org"])
        sent = email.message_from_bytes(self.out.joinpath("message.1").read_bytes(), policy=policy.default)
        self.assertIn("-- \nAda Lovelace", sent.get_body().get_content())
        self.assertEqual(json.loads(Path(self.dir, "stats.json").read_text())["modified"], 1)

    def test_passes_a_skipped_message_through_byte_for_byte(self):
        raw = plain("Away\n", extra_headers="Auto-Submitted: auto-replied\n")
        self.assertEqual(self.run_script(raw).returncode, 0)
        self.assertEqual(self.out.joinpath("message.1").read_bytes(), raw)

    def test_keeps_a_null_sender_null(self):
        self.assertEqual(self.run_script(plain("bounce\n"), [f"-u={ADA}", "-f=", "--", "bob@other.org"]).returncode, 0)
        self.assertEqual(self.out.joinpath("args.1").read_text().split()[2:4], ["-f", "<>"])

    def test_resends_the_original_when_postfix_refuses_the_edited_message(self):
        self.set_sendmail(failures_first=1)
        raw = plain("Hello\n")
        self.assertEqual(self.run_script(raw).returncode, 0)
        self.assertEqual(self.out.joinpath("message.2").read_bytes(), raw)
        self.assertIn(b"Ada Lovelace", self.out.joinpath("message.1").read_bytes())

    def test_asks_postfix_to_retry_later_when_nothing_can_be_handed_back(self):
        self.set_sendmail(0, always_fail=True)
        self.assertEqual(self.run_script(plain("Hello\n")).returncode, sf.EX_TEMPFAIL)

    def test_never_loses_mail_when_the_filter_itself_breaks(self):
        Path(self.dir, f"{ADA}.json").write_text('{"v": 1, "enforceServerSide": true, "signature": {"html": 5}, "banners": "oops"}')
        raw = plain("Hello\n")
        self.assertEqual(self.run_script(raw).returncode, 0)
        self.assertEqual(self.out.joinpath("message.1").read_bytes(), raw)

    def test_defers_rather_than_dropping_when_called_with_no_recipients(self):
        self.assertEqual(self.run_script(plain("Hello\n"), [f"-u={ADA}", f"-f={ADA}", "--"]).returncode, sf.EX_TEMPFAIL)
        self.assertFalse(self.out.joinpath("message.1").exists())


@unittest.skipIf(os.name == "nt", "needs a POSIX shell for the wrapper")
class Wrapper(EndToEnd):
    """The shell wrapper Postfix actually runs. It repeats every end-to-end test above, then adds the cases
    only it can handle: Python missing or crashing, where the original must still be delivered."""

    WRAPPER = Path(sf.__file__).with_name("signature_filter.sh")

    def run_script(self, raw: bytes, args=None, python: str | None = None):
        env = {
            **os.environ,
            "VEXLYX_SIGNATURES_DIR": self.dir,
            "VEXLYX_SENDMAIL": str(self.sendmail),
            "VEXLYX_SIGNATURE_STATS": str(Path(self.dir, "stats.json")),
            "VEXLYX_PYTHON": python or sys.executable,
            "VEXLYX_FILTER": str(Path(sf.__file__)),
            "TMPDIR": self.dir,
        }
        return subprocess.run(
            ["sh", str(self.WRAPPER), *(args or [f"-u={ADA}", f"-f={ADA}", "--", "bob@other.org", "carol@other.org"])],
            input=raw,
            capture_output=True,
            env=env,
        )

    def sent_count(self) -> int:
        return len(list(self.out.glob("message.*")))

    def test_delivers_the_original_when_python_is_missing(self):
        raw = plain("Hello\n")
        result = self.run_script(raw, python="/nonexistent/python3")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.sent_count(), 1)
        self.assertEqual(self.out.joinpath("message.1").read_bytes(), raw)
        self.assertEqual(self.out.joinpath("args.1").read_text().split(), ["-G", "-i", "-f", ADA, "--", "bob@other.org", "carol@other.org"])

    def test_delivers_the_original_when_the_filter_crashes(self):
        crash = Path(self.dir, "crash")
        crash.write_text("#!/bin/sh\ncat > /dev/null\nexit 1\n")
        crash.chmod(0o755)
        raw = plain("Hello\n")
        self.assertEqual(self.run_script(raw, python=str(crash)).returncode, 0)
        self.assertEqual(self.out.joinpath("message.1").read_bytes(), raw)

    def test_delivers_exactly_one_copy_when_the_filter_works(self):
        self.assertEqual(self.run_script(plain("Hello\n")).returncode, 0)
        self.assertEqual(self.sent_count(), 1)

    def test_a_recipient_shaped_like_an_option_is_still_a_recipient_in_the_fallback(self):
        result = self.run_script(plain("x\n"), [f"-u={ADA}", f"-f={ADA}", "--", "-f=evil@x.com"], python="/nonexistent/python3")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.out.joinpath("args.1").read_text().split(), ["-G", "-i", "-f", ADA, "--", "-f=evil@x.com"])

    def test_keeps_a_null_sender_null_in_the_fallback(self):
        self.run_script(plain("bounce\n"), [f"-u={ADA}", "-f=", "--", "bob@other.org"], python="/nonexistent/python3")
        self.assertEqual(self.out.joinpath("args.1").read_text().split()[2:4], ["-f", "<>"])

    def test_asks_postfix_to_retry_when_even_the_fallback_is_refused(self):
        self.set_sendmail(0, always_fail=True)
        self.assertEqual(self.run_script(plain("Hello\n"), python="/nonexistent/python3").returncode, 75)

    def test_leaves_no_temporary_copy_of_the_message_behind(self):
        before = set(os.listdir(self.dir))
        self.run_script(plain("Hello\n"))
        self.run_script(plain("Hello\n"), python="/nonexistent/python3")
        leftovers = [name for name in set(os.listdir(self.dir)) - before if name.startswith("tmp.")]
        self.assertEqual(leftovers, [])


if __name__ == "__main__":
    unittest.main()
