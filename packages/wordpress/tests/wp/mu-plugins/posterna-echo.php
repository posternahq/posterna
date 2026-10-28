<?php
/**
 * Test helper for the wp-env end-to-end run only (never shipped): with
 * ?posterna_echo=1, prints the verdict Posterna gave this request, the
 * X-Agent-* values the rest of the site sees, and how often the
 * posterna_verdict action fired, as JSON.
 *
 * @package Posterna
 */

defined( 'ABSPATH' ) || exit;

$GLOBALS['posterna_echo_fired'] = 0;

add_action(
	'posterna_verdict',
	function () {
		++$GLOBALS['posterna_echo_fired'];
	}
);

add_action(
	'wp_loaded',
	function () {
		if ( ! isset( $_GET['posterna_echo'] ) || ! function_exists( 'posterna_get_verdict' ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			return;
		}
		$seen = array();
		foreach ( $_SERVER as $key => $value ) {
			if ( 0 === strpos( $key, 'HTTP_X_AGENT_' ) || 0 === strpos( $key, 'HTTP_X_POSTERNA_' ) ) {
				$seen[ $key ] = $value;
			}
		}
		wp_send_json(
			array(
				'verdict'  => posterna_get_verdict(),
				'server'   => $seen,
				'fired'    => $GLOBALS['posterna_echo_fired'],
				'stripped' => Posterna\Plugin::instance()->stripped(),
				'ms'       => Posterna\Plugin::instance()->elapsed_ms(),
			)
		);
	}
);
