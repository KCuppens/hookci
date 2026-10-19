import { QUOTAS } from "../quotas";
import { S } from "../strings";
import { escapeHtml, page } from "./layout";

const P = S.pages;

function section(heading: string, bodyHtml: string): string {
	return `<h2>${escapeHtml(heading)}</h2>\n${bodyHtml}`;
}

function para(text: string): string {
	return `<p>${escapeHtml(text)}</p>`;
}

function mailto(address: string): string {
	return `<a href="mailto:${escapeHtml(address)}">${escapeHtml(address)}</a>`;
}

/** What the hosted hub collects, where and how long it keeps it, and how users delete or export it. */
export function privacyPage(): Response {
	const collected = P.privacyCollected.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n");
	return page(
		P.privacyTitle,
		[
			para(P.privacyIntro),
			section(P.privacyCollectedHeading, `<ul>\n${collected}\n</ul>\n${para(P.privacySourceCode)}`),
			section(P.privacyStorageHeading, para(P.privacyStorage)),
			section(P.privacyRetentionHeading, para(P.privacyRetention(QUOTAS.retentionDays))),
			section(P.privacyDeletionHeading, para(P.privacyDeletion)),
			section(P.privacyExportHeading, para(P.privacyExport)),
			section(P.privacySubprocessorsHeading, para(P.privacySubprocessors)),
			section(P.contactHeading, `<p>${escapeHtml(P.contactBody)} ${mailto(P.contactEmail)}</p>`),
		].join("\n"),
	);
}

export function termsPage(): Response {
	return page(
		P.termsTitle,
		[
			section(P.termsUseHeading, para(P.termsUse)),
			section(P.termsAcceptableHeading, para(P.termsAcceptable)),
			section(P.termsWarrantyHeading, para(P.termsWarranty)),
			section(P.termsTerminationHeading, para(P.termsTermination)),
			section(P.termsChangesHeading, para(P.termsChanges)),
			section(P.contactHeading, `<p>${mailto(P.contactEmail)}</p>`),
		].join("\n"),
	);
}

export function supportPage(): Response {
	return page(
		P.supportTitle,
		[
			section(P.supportHelpHeading, `<p>${escapeHtml(P.supportHelp)} <a href="${P.supportIssuesUrl}">${P.supportIssuesUrl}</a></p>`),
			section(P.supportEmailHeading, `<p>${mailto(P.supportEmail)}</p>`),
			section(P.supportSecurityHeading, `<p>${escapeHtml(P.supportSecurity)} <a href="${P.securityPolicyUrl}">${P.securityPolicyUrl}</a></p>`),
		].join("\n"),
	);
}
