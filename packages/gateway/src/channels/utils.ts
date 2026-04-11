/**
 * Shared utilities for channel adapters.
 *
 * Centralizes phone normalization, sender-allow-list checking,
 * and long-message splitting that were previously duplicated
 * across multiple adapter files.
 */

/**
 * Normalize a phone number for comparison.
 * Strips known channel prefixes (whatsapp:, signal:, tel:),
 * preserves leading +, removes all non-digit characters.
 */
export function normalizePhone(phone: string): string {
	const trimmed = phone.trim();
	// Strip known protocol/channel prefixes
	const cleaned = trimmed.replace(/^(whatsapp|signal|tel):/i, "");
	if (cleaned.startsWith("+")) {
		return `+${cleaned.slice(1).replace(/\D/g, "")}`;
	}
	return cleaned.replace(/\D/g, "");
}

type AllowFromMode = "phone" | "id" | "email";

/**
 * Check whether a sender is permitted by an allowFrom list.
 * Returns true if allowFrom is empty/undefined (open access).
 *
 * Modes:
 * - "phone": normalizes both sides before comparing
 * - "id": exact string match (Discord user IDs, Telegram user IDs, Slack user IDs)
 * - "email": case-insensitive match
 */
export function isAllowed(
	sender: string,
	allowFrom: string[] | undefined,
	mode: AllowFromMode = "id",
): boolean {
	if (!allowFrom || allowFrom.length === 0) return true;

	switch (mode) {
		case "phone":
			return allowFrom.some((entry) => normalizePhone(entry) === normalizePhone(sender));
		case "email":
			return allowFrom.some((entry) => entry.toLowerCase() === sender.toLowerCase());
		case "id":
			return allowFrom.includes(sender);
	}
}

/**
 * Split a long message into chunks that respect a max character limit.
 * Splits on newline boundaries first; hard-splits lines exceeding the limit.
 */
export function splitMessage(text: string, maxLength: number): string[] {
	if (text.length <= maxLength) return [text];

	const chunks: string[] = [];
	let current = "";

	for (const line of text.split("\n")) {
		if (current.length + line.length + 1 > maxLength) {
			if (current) {
				chunks.push(current);
				current = "";
			}
			// Single line exceeds limit — hard-split
			if (line.length > maxLength) {
				for (let i = 0; i < line.length; i += maxLength) {
					chunks.push(line.slice(i, i + maxLength));
				}
				continue;
			}
		}
		current = current ? `${current}\n${line}` : line;
	}
	if (current) chunks.push(current);

	return chunks;
}
