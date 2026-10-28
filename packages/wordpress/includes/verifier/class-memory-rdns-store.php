<?php
/**
 * Reverse DNS results kept in memory, for one process.
 *
 * @package Posterna
 */

namespace Posterna\Verifier;

defined( 'ABSPATH' ) || exit;

/**
 * Used by the conformance tests and the benchmark.
 */
final class Memory_Rdns_Store implements Rdns_Store {

	/**
	 * Entries by address.
	 *
	 * @var array
	 */
	private $entries = array();

	/**
	 * Queued addresses.
	 *
	 * @var array
	 */
	private $queue = array();

	/**
	 * The stored entry for an address, or null.
	 *
	 * @param string $ip Address.
	 * @return array|null
	 */
	public function get( $ip ) {
		return isset( $this->entries[ $ip ] ) ? $this->entries[ $ip ] : null;
	}

	/**
	 * Stores an entry.
	 *
	 * @param string $ip          Address.
	 * @param array  $entry       Entry.
	 * @param int    $ttl_seconds Unused; entries carry their own expiry.
	 */
	public function set( $ip, $entry, $ttl_seconds ) {
		$this->entries[ $ip ] = $entry;
	}

	/**
	 * Adds an address to the lookup queue.
	 *
	 * @param string $ip Address.
	 */
	public function enqueue( $ip ) {
		$this->queue[ $ip ] = true;
	}

	/**
	 * Removes and returns queued addresses.
	 *
	 * @param int $limit Maximum, or 0 for all.
	 * @return array
	 */
	public function dequeue( $limit ) {
		$all         = array_keys( $this->queue );
		$taken       = $limit > 0 ? array_slice( $all, 0, $limit ) : $all;
		$this->queue = array_fill_keys( array_slice( $all, count( $taken ) ), true );
		return $taken;
	}
}
