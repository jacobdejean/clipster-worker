import { customAlphabet } from 'nanoid';

export function generateId(suffix?: string) {
	const nanoid = customAlphabet('1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 6);
	return 'O' + nanoid() + (suffix ? `${suffix}` : '');
}
