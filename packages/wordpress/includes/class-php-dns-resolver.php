<?php
/**
 * DNS lookups with PHP's resolver.
 *
 * @package Posterna
 */

namespace Posterna;

use Posterna\Verifier\Address;
use Posterna\Verifier\Dns_Resolver;

defined( 'ABSPATH' ) || exit;

/**
 * Uses dns_get_record(). PHP has no per-lookup timeout, so lookups only ever
 * run in WP-Cron, a few at a time, never during a page load.
 */
final class Php_Dns_Resolver implements Dns_Resolver {

	/**
	 * True when dns_get_record() is available.
	 *
	 * @return bool
	 */
	public static function available() {
		return function_exists( 'dns_get_record' );
	}

	/**
	 * Runs one query.
	 *
	 * @param string $name Query name.
	 * @param int    $type DNS_PTR, or DNS_A | DNS_AAAA.
	 * @return array
	 * @throws \RuntimeException When the lookup fails (as opposed to finding nothing).
	 */
	private static function query( $name, $type ) {
		$message = null;
		// dns_get_record() reports failures as PHP warnings; capture them as an error instead.
		set_error_handler( // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_set_error_handler
			function ( $severity, $text ) use ( &$message ) {
				$message = $text;
				return true;
			}
		);
		try {
			$records = dns_get_record( $name, $type );
		} finally {
			restore_error_handler();
		}
		if ( false === $records ) {
			$exception = new \RuntimeException( null === $message ? 'DNS query failed' : 'DNS query failed: ' . preg_replace( '/^dns_get_record\(\): /', '', $message ) );
			throw $exception;
		}
		return $records;
	}

	/**
	 * PTR names for an address.
	 *
	 * @param string $ip Address in normal form.
	 * @return array
	 */
	public function reverse( $ip ) {
		$address = Address::parse( $ip );
		if ( null === $address ) {
			return array();
		}
		if ( 'ipv4' === $address->family ) {
			$name = implode( '.', array_reverse( explode( '.', $address->text ) ) ) . '.in-addr.arpa';
		} else {
			$name = implode( '.', array_reverse( str_split( $address->hex ) ) ) . '.ip6.arpa';
		}
		$names = array();
		foreach ( self::query( $name, DNS_PTR ) as $record ) {
			if ( isset( $record['target'] ) && is_string( $record['target'] ) ) {
				$names[] = $record['target'];
			}
		}
		return $names;
	}

	/**
	 * A and AAAA addresses for a name.
	 *
	 * @param string $hostname Name.
	 * @return array
	 */
	public function forward( $hostname ) {
		$addresses = array();
		foreach ( self::query( $hostname, DNS_A | DNS_AAAA ) as $record ) {
			if ( isset( $record['ip'] ) ) {
				$addresses[] = $record['ip'];
			}
			if ( isset( $record['ipv6'] ) ) {
				$addresses[] = $record['ipv6'];
			}
		}
		return $addresses;
	}
}
