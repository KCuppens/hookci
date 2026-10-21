/**
 * An expected failure. The Worker answers it with `{"error": code}` and
 * `status`; message is for logs and is never sent to the client.
 */
export class HubError extends Error {
	constructor(
		public code: string,
		public status: number = 400,
		message?: string,
	) {
		super(message ?? code);
		this.name = "HubError";
	}
}
