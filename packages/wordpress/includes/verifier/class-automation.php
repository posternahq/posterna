<?php
/**
 * Automation signals for requests that claim no known agent.
 *
 * @package Posterna
 */

namespace Posterna\Verifier;

defined( 'ABSPATH' ) || exit;

/**
 * Labels a request as automated or not, using only signals already in the
 * request: a User-Agent no mainstream browser sends, or a missing header
 * every mainstream browser sends. This is labeling, not scoring
 * (docs/SPEC.md section 4.6). It must never grow into fingerprinting: no
 * timing, no ordering, no client hints, no history.
 */
final class Automation {

	const WORDS = '/bot|crawl|spider|slurp|scrape|fetch|headless|python|curl|wget|httpclient|okhttp|go-http|java\/|axios|node-fetch|undici|libwww|scrapy|playwright|puppeteer|selenium/i';

	/**
	 * Which signal fired, as a reason code, or null for a browser.
	 *
	 * @param Request $request Request.
	 * @return string|null
	 */
	public static function signal( $request ) {
		$user_agent = $request->value( 'user-agent' );
		if ( null === $user_agent || '' === $user_agent ) {
			return 'no_user_agent';
		}
		if ( ! preg_match( '/^Mozilla\/\d/', $user_agent ) ) {
			return 'non_browser_user_agent';
		}
		if ( preg_match( self::WORDS, $user_agent ) ) {
			return 'automation_token';
		}
		$accept = $request->value( 'accept' );
		if ( null === $accept || '' === $accept ) {
			return 'missing_accept';
		}
		$language = $request->value( 'accept-language' );
		if ( null === $language || '' === $language ) {
			return 'missing_accept_language';
		}
		return null;
	}
}
