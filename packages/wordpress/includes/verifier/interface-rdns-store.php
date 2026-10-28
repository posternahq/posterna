<?php
/**
 * Where reverse DNS results and the lookup queue are kept.
 *
 * @package Posterna
 */

namespace Posterna\Verifier;

defined( 'ABSPATH' ) || exit;

/**
 * In the plugin, results live in transients and the queue in an option; in
 * tests both live in memory.
 */
interface Rdns_Store {

	/**
	 * The stored entry for an address, or null.
	 *
	 * @param string $ip Address.
	 * @return array|null
	 */
	public function get( $ip );

	/**
	 * Stores an entry.
	 *
	 * @param string $ip          Address.
	 * @param array  $entry       Entry.
	 * @param int    $ttl_seconds How long to keep it.
	 */
	public function set( $ip, $entry, $ttl_seconds );

	/**
	 * Adds an address to the lookup queue.
	 *
	 * @param string $ip Address.
	 */
	public function enqueue( $ip );

	/**
	 * Removes and returns up to $limit queued addresses (0 for all).
	 *
	 * @param int $limit Maximum.
	 * @return array
	 */
	public function dequeue( $limit );
}
