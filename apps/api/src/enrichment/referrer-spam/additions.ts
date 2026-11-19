/**
 * Ottertrail's own additions to the referrer spam list: domains seen
 * sending referrer spam that Matomo's list (list.ts) does not hold yet.
 * Matched like that list's: each domain and its subdomains
 * (enrichment/referrer-spam.ts). The refresh script never writes this file.
 *
 * One domain per line; a line starting with # is a comment. Add a domain
 * only with evidence that it sends referrer spam, with a comment saying
 * where it was seen, and propose it to Matomo's list too
 * (https://github.com/matomo-org/referrer-spam-list, one pull request per
 * domain), so every user of that list benefits. Once Matomo's list holds
 * it, remove it here.
 */
export const REFERRER_SPAM_ADDITIONS = `
# Domains Ottertrail adds to Matomo's list. None yet.

# Under .invalid, which never resolves, so it matches no real referrer:
# the collection tests send it to check that this file is loaded.
check-additions.ottertrail.invalid
`;
