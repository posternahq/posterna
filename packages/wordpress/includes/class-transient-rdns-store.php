<?php
/**
 * Reverse DNS results in transients, and the lookup queue in an option.
 *
 * @package Posterna
 */

namespace Posterna;

use Posterna\Verifier\Rdns_Store;

defined( 'ABSPATH' ) || exit;

/**
 * Results are cached for 24 hours when confirmed, 1 hour when not, and 1
 * minute after a lookup error. The queue holds at most 100 addresses and is
 * worked through by the posterna_rdns WP-Cron event, never by a page load.
 */
final class Transient_Rdns_Store implements Rdns_Store {

	const QUEUE_OPTION = 'posterna_rdns_queue';
	const QUEUE_LIMIT  = 100;
	const CRON_HOOK    = 'posterna_rdns';

	/**
	 * The transient name for an address. Addresses are hashed so none appears in the options table.
	 *
	 * @param string $ip Address.
	 * @return string
	 */
	private static function key( $ip ) {
		return 'posterna_rdns_' . md5( $ip );
	}

	/**
	 * The stored entry for an address, or null.
	 *
	 * @param string $ip Address.
	 * @return array|null
	 */
	public function get( $ip ) {
		$entry = get_transient( self::key( $ip ) );
		return is_array( $entry ) ? $entry : null;
	}

	/**
	 * Stores an entry.
	 *
	 * @param string $ip          Address.
	 * @param array  $entry       Entry.
	 * @param int    $ttl_seconds How long to keep it.
	 */
	public function set( $ip, $entry, $ttl_seconds ) {
		set_transient( self::key( $ip ), $entry, max( 1, (int) $ttl_seconds ) );
	}

	/**
	 * Adds an address to the queue and makes sure a lookup run is scheduled.
	 *
	 * @param string $ip Address.
	 */
	public function enqueue( $ip ) {
		$queue = get_option( self::QUEUE_OPTION, array() );
		$queue = is_array( $queue ) ? $queue : array();
		if ( ! in_array( $ip, $queue, true ) && count( $queue ) < self::QUEUE_LIMIT ) {
			$queue[] = $ip;
			update_option( self::QUEUE_OPTION, $queue, false );
		}
		if ( false === wp_next_scheduled( self::CRON_HOOK ) ) {
			wp_schedule_single_event( time() + 30, self::CRON_HOOK );
		}
	}

	/**
	 * Removes and returns up to $limit queued addresses.
	 *
	 * @param int $limit Maximum, or 0 for all.
	 * @return array
	 */
	public function dequeue( $limit ) {
		$queue = get_option( self::QUEUE_OPTION, array() );
		$queue = is_array( $queue ) ? array_values( $queue ) : array();
		$taken = $limit > 0 ? array_slice( $queue, 0, $limit ) : $queue;
		update_option( self::QUEUE_OPTION, array_slice( $queue, count( $taken ) ), false );
		return $taken;
	}
}
