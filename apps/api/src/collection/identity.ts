/**
 * Known users: a site says which of its users is signed in, and every event
 * from then on carries that user's ID (docs/web-analytics.md, section 2).
 * The ID is the site's own, such as its database ID for the user; the docs
 * ask for that rather than an email address.
 */

/**
 * 1 to 200 characters, no control characters (C0, DEL, and C1). At least as
 * strict as the database's check (migration 0015), so an ID it refuses
 * gets a 400.
 */
export const USER_ID_PATTERN = "^[^\\u0000-\\u001F\\u007F-\\u009F]{1,200}$";
