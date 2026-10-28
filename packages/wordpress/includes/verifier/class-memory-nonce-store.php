<?php
/**
 * Nonces kept in memory, for one process.
 *
 * @package Posterna
 */

namespace Posterna\Verifier;

defined( 'ABSPATH' ) || exit;

/**
 * A size-bounded set that forgets the oldest entry first.
 */
final class Memory_Nonce_Store implements Nonce_Store {

	/**
	 * Keys in insertion order.
	 *
	 * @var array
	 */
	private $keys = array();

	/**
	 * Most keys kept.
	 *
	 * @var int
	 */
	private $capacity;

	/**
	 * Creates the store.
	 *
	 * @param int $capacity Most keys kept.
	 */
	public function __construct( $capacity = 10000 ) {
		$this->capacity = max( 1, (int) $capacity );
	}

	/**
	 * True when the key was seen before.
	 *
	 * @param string $key Key.
	 * @return bool
	 */
	public function has( $key ) {
		return isset( $this->keys[ $key ] );
	}

	/**
	 * Remembers a key.
	 *
	 * @param string $key Key.
	 */
	public function add( $key ) {
		if ( count( $this->keys ) >= $this->capacity ) {
			unset( $this->keys[ array_key_first( $this->keys ) ] );
		}
		$this->keys[ $key ] = true;
	}
}
