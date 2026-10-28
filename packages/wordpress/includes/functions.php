<?php
/**
 * Functions for other plugins and themes.
 *
 * @package Posterna
 */

defined( 'ABSPATH' ) || exit;

/**
 * The verdict for the current request.
 *
 * The request is checked once, early (on plugins_loaded, before the theme
 * loads); calling this later returns the same result. Returns null in WP-CLI
 * and WP-Cron, which have no visitor.
 *
 * Example:
 *
 *     $verdict = posterna_get_verdict();
 *     if ( $verdict && 'verified_by_ip' === $verdict['verdict'] ) {
 *         // A crawler confirmed by its operator's published addresses.
 *     }
 *
 * @since 1.0.0
 *
 * @return array|null array( 'verdict' => one of verified_by_signature, verified_by_ip,
 *                    declared_unverifiable, claimed_failed, unknown_automation, human;
 *                    and when set: 'operator' (directory slug), 'agent', 'purpose',
 *                    'method' (signature, ip, rdns or none), 'reason' (a reason code),
 *                    'note', 'error' ).
 */
function posterna_get_verdict() {
	return Posterna\Plugin::instance()->verdict();
}
