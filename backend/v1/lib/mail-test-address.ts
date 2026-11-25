/**
 * Recipient for every test that can send mail. It must be a real, deliverable inbox: a made-up
 * address or domain bounces, and bounces get the sending Gmail account flagged.
 */
export const MAIL_TEST_ADDRESS = 'kingvixel90@gmail.com';

/**
 * A distinct address that still lands in the same inbox (Gmail plus-addressing). Use it where a test
 * needs several unique emails, e.g. one invite per recipient.
 */
export const mailTestAddress = (tag: string): string => `kingvixel90+${tag}@gmail.com`;
