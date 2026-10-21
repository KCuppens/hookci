// Account email (verify, "you already have an account", reset) through the
// Cloudflare Email Service send_email binding. Routes only see EmailSender, so
// tests pass a fake through env.__TEST_EMAIL and nothing touches the network.
// Every message carries an HTML and a plain-text part, as the service advises.

import type { Env } from "../env";
import { escapeHtml } from "../pages/layout";
import { S } from "../strings";

export interface OutgoingEmail {
	to: string;
	subject: string;
	html: string;
	text: string;
}

export interface EmailSender {
	send(mail: OutgoingEmail): Promise<void>;
}

/** The shape of the Cloudflare Email Service binding that account email uses. */
export interface EmailBinding {
	send(message: { to: string; from: { email: string; name: string }; subject: string; html: string; text: string }): Promise<unknown>;
}

/** The sender to use, or null when account email is not configured (no binding or no ACCOUNTS_MAIL_FROM). */
export function emailSenderFor(env: Env): EmailSender | null {
	if (env.__TEST_EMAIL) return env.__TEST_EMAIL;
	const { EMAIL: binding, ACCOUNTS_MAIL_FROM: from } = env;
	if (!binding || !from) return null;
	return {
		async send(mail) {
			await binding.send({ ...mail, from: { email: from, name: S.account.mail.fromName } });
		},
	};
}

interface Action {
	label: string;
	url: string;
}

function render(subject: string, intro: string, actions: Action[], note: string, text: string, to: string): OutgoingEmail {
	const buttons = actions
		.map(
			(a, i) =>
				`<p style="margin:0 0 12px"><a href="${escapeHtml(a.url)}" style="display:inline-block;padding:12px 20px;border-radius:10px;font-weight:600;text-decoration:none;${
					i === 0 ? "background:#0f141d;color:#ffffff" : "background:#fff1ea;color:#0f141d"
				}">${escapeHtml(a.label)}</a></p>`,
		)
		.join("");
	const html = `<!doctype html><html lang="en"><body style="margin:0;padding:24px;background:#faf8f6;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f141d"><div style="max-width:480px;margin:0 auto;padding:28px;background:#ffffff;border:1px solid #e8e9ec;border-radius:16px"><p style="margin:0 0 16px;font-size:20px;font-weight:700">${escapeHtml(S.account.mail.fromName)}</p><p style="margin:0 0 20px;line-height:1.5;color:#3b4350">${escapeHtml(intro)}</p>${buttons}<p style="margin:20px 0 0;font-size:13px;line-height:1.5;color:#667085">${escapeHtml(note)}</p></div></body></html>`;
	return { to, subject, html, text };
}

export function verifyEmail(to: string, link: string): OutgoingEmail {
	const m = S.account.mail;
	return render(m.verifySubject, m.verifyIntro, [{ label: m.verifyButton, url: link }], m.verifyNote, m.verifyText(link), to);
}

export function existsEmail(to: string, signInLink: string, resetLink: string): OutgoingEmail {
	const m = S.account.mail;
	return render(
		m.existsSubject,
		m.existsIntro,
		[
			{ label: m.existsSignIn, url: signInLink },
			{ label: m.existsReset, url: resetLink },
		],
		m.verifyNote,
		m.existsText(signInLink, resetLink),
		to,
	);
}

export function resetEmail(to: string, link: string): OutgoingEmail {
	const m = S.account.mail;
	return render(m.resetSubject, m.resetIntro, [{ label: m.resetButton, url: link }], m.resetNote, m.resetText(link), to);
}
